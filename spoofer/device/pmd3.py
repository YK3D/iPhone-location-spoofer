"""Talk to the iPhone in-process through the pymobiledevice3 Python API.

Keeps one connection open, so a new location can be sent every fraction of a second (needed
for smooth routes, pause/resume and the joystick). Written against pymobiledevice3 11.x.

* iOS 17+: opens the no-admin userspace RSD tunnel (iOS 17.4+), falling back to a running
  `tunneld` (iOS 17.0-17.3, needs `pymobiledevice3 remote tunneld` as administrator), mounts
  the personalised Developer Disk Image if needed, then uses the DVT LocationSimulation channel.
* iOS 16 and older: lockdown `com.apple.dt.simulatelocation` after mounting the classic DDI.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import AsyncExitStack
from typing import Any, Optional

from .base import DeviceDriver, DeviceError, DeviceInfo

log = logging.getLogger(__name__)


def _major(version: str) -> int:
    try:
        return int(version.split(".")[0])
    except (ValueError, IndexError):
        return 0


def _friendly(e: BaseException) -> str:
    name = e.__class__.__name__
    msg = str(e) or name
    hints = {
        "ConnectionFailedToUsbmuxdError": "Cannot reach the Apple device service. On Windows open the Apple Devices app (or iTunes) and keep it open.",
        "NoDeviceConnectedError": "No iPhone found. Plug it in with a cable, unlock it and tap Trust.",
        "PasswordRequiredError": "Unlock the iPhone and try again.",
        "PairingDialogResponsePendingError": "Tap Trust on the iPhone, enter the passcode, then try again.",
        "UserDeniedPairingError": "The iPhone refused to trust this computer. Unplug, plug back in and tap Trust.",
        "DeveloperModeIsNotEnabledError": "Developer Mode is off. Use 'Reveal Developer Mode', then turn it on in Settings > Privacy & Security.",
        "DeveloperModeError": "Developer Mode is off. Use 'Reveal Developer Mode', then turn it on in Settings > Privacy & Security.",
        "TunneldConnectionError": "This iOS version (17.0-17.3) needs tunneld. Run 'start_tunneld.bat' as administrator, then connect again.",
        "InvalidServiceError": "The developer service is not available. Make sure Developer Mode is on and the Developer Disk Image is mounted.",
    }
    return hints.get(name, f"{name}: {msg}")


class Pmd3Driver(DeviceDriver):
    key = "pmd3"
    label = "Direct (pymobiledevice3 API)"
    live = True

    def __init__(self) -> None:
        super().__init__()
        self._stack: Optional[AsyncExitStack] = None
        self._sim: Any = None
        self._lock = asyncio.Lock()

    async def list_devices(self) -> list[dict]:
        try:
            from pymobiledevice3 import usbmux
            from pymobiledevice3.lockdown import create_using_usbmux
        except ImportError as e:
            raise DeviceError(f"pymobiledevice3 is not installed: {e}") from e
        try:
            devices = await usbmux.list_devices()
        except Exception as e:
            raise DeviceError(_friendly(e)) from e
        out = []
        seen = set()
        for d in devices:
            if d.serial in seen:
                continue
            seen.add(d.serial)
            entry = {"udid": d.serial, "connection": d.connection_type, "name": "", "ios_version": ""}
            try:
                ld = await create_using_usbmux(serial=d.serial, autopair=False)
                try:
                    info = ld.short_info
                    entry["name"] = info.get("DeviceName", "")
                    entry["ios_version"] = info.get("ProductVersion", "")
                finally:
                    await ld.close()
            except Exception as e:  # not paired yet, locked, ...
                entry["error"] = _friendly(e)
            out.append(entry)
        return out

    async def connect(self, udid: Optional[str] = None) -> DeviceInfo:
        await self.disconnect()
        try:
            from pymobiledevice3.lockdown import create_using_usbmux
        except ImportError as e:
            raise DeviceError(f"pymobiledevice3 is not installed: {e}") from e

        stack = AsyncExitStack()
        notes: list[str] = []
        try:
            lockdown = await create_using_usbmux(serial=udid, autopair=True)
            stack.push_async_callback(lockdown.close)
            short = lockdown.short_info
            version = lockdown.product_version
            info = DeviceInfo(
                udid=lockdown.udid,
                name=short.get("DeviceName", "iPhone"),
                ios_version=version,
                product_type=short.get("ProductType", ""),
                connection="USB",
            )
            if _major(version) >= 17:
                serial = udid or getattr(lockdown, "identifier", None) or lockdown.udid
                rsd, how = await self._open_rsd(stack, serial, lockdown.udid)
                notes.append(await self._try_mount(rsd))
                from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
                from pymobiledevice3.services.dvt.instruments.location_simulation import LocationSimulation

                dvt = await stack.enter_async_context(DvtProvider(rsd))
                self._sim = await stack.enter_async_context(LocationSimulation(dvt))
                info.transport = f"DVT over {how}"
            else:
                notes.append(await self._try_mount(lockdown))
                from pymobiledevice3.services.simulate_location import DtSimulateLocation

                self._sim = DtSimulateLocation(lockdown)
                info.transport = "Lockdown simulatelocation"
        except DeviceError:
            await stack.aclose()
            raise
        except Exception as e:
            await stack.aclose()
            raise DeviceError(_friendly(e)) from e

        info.notes = [n for n in notes if n]
        self._stack = stack
        self.info = info
        return info

    async def _open_rsd(self, stack: AsyncExitStack, serial: str, udid: str):
        from pymobiledevice3.exceptions import UserspaceTunnelUnavailableError
        from pymobiledevice3.remote.userspace_tunnel import UserspaceRsdTunnel

        try:
            tunnel = UserspaceRsdTunnel(serial=serial, remotepairing_fallback=False)
            rsd = await tunnel.aopen()
            stack.push_async_callback(tunnel.aclose)
            return rsd, "userspace tunnel (no admin)"
        except UserspaceTunnelUnavailableError:
            log.info("userspace tunnel unavailable (iOS 17.0-17.3?), trying tunneld")
        # iOS 17.0-17.3: a privileged tunneld must already be running.
        from pymobiledevice3.tunneld.api import get_tunneld_devices

        try:
            rsds = await get_tunneld_devices()
        except Exception as e:
            raise DeviceError(
                "This iOS version needs tunneld. Run start_tunneld.bat as administrator, keep it open, then connect again."
            ) from e
        match = None
        for r in rsds:
            if match is None and r.udid in (udid, serial):
                match = r
            else:
                await r.close()
        if match is None:
            raise DeviceError("tunneld is running but has no tunnel to this iPhone yet. Wait a few seconds and retry.")
        stack.push_async_callback(match.close)
        return match, "tunneld"

    async def _try_mount(self, provider: Any) -> str:
        try:
            from pymobiledevice3.exceptions import AlreadyMountedError
            from pymobiledevice3.services.mobile_image_mounter import auto_mount
        except ImportError:
            return ""
        try:
            await auto_mount(provider)
            return "Mounted the Developer Disk Image."
        except AlreadyMountedError:
            return ""
        except Exception as e:  # location may still work if an image is mounted already
            log.warning("DDI auto-mount failed: %r", e)
            return f"Could not auto-mount the Developer Disk Image ({_friendly(e)}). If setting a location fails, check Developer Mode and the internet connection."

    async def disconnect(self) -> None:
        stack, self._stack = self._stack, None
        self._sim = None
        self.info = None
        if stack is not None:
            try:
                await stack.aclose()
            except Exception as e:  # device already gone
                log.debug("disconnect: %r", e)

    async def set_location(self, lat: float, lon: float) -> None:
        if self._sim is None:
            raise DeviceError("Not connected")
        async with self._lock:
            try:
                await self._sim.set(lat, lon)
            except Exception as e:
                await self.disconnect()
                raise DeviceError(f"Lost the connection to the iPhone: {_friendly(e)}") from e

    async def clear_location(self) -> None:
        if self._sim is None:
            raise DeviceError("Not connected")
        async with self._lock:
            try:
                await self._sim.clear()
            except Exception as e:
                await self.disconnect()
                raise DeviceError(f"Lost the connection to the iPhone: {_friendly(e)}") from e

    async def reveal_developer_mode(self, udid: Optional[str] = None) -> str:
        try:
            from pymobiledevice3.lockdown import create_using_usbmux
            from pymobiledevice3.services.amfi import AmfiService

            ld = await create_using_usbmux(serial=udid or (self.info.udid if self.info else None), autopair=True)
            try:
                await AmfiService(ld).reveal_developer_mode_option_in_ui()
            finally:
                await ld.close()
        except Exception as e:
            raise DeviceError(_friendly(e)) from e
        return "Done. On the iPhone open Settings > Privacy & Security > Developer Mode, switch it on and restart."

    async def mount_developer_image(self) -> str:
        if not self.connected:
            raise DeviceError("Connect first")
        # Reconnecting runs the mount step with the right provider (RSD on iOS 17+).
        info = await self.connect(self.info.udid if self.info else None)
        return " ".join(info.notes) or "Developer Disk Image is mounted."
