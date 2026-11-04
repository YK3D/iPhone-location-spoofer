"""More than one iPhone at a time: extra phones ("mirrors") follow the main one.

The player only ever talks to the main phone (through FanOut). Every position it sends is also
handed to each mirror, which sends it from its own task: a slow or lost mirror never holds up
playback on the main phone. A mirror that is behind skips straight to the newest position, and a
mirror that stops answering is marked as lost (the others keep going) until it is removed.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Callable, Optional

from .device.base import DeviceDriver, DeviceError, DeviceInfo

SEND_TIMEOUT_S = 20.0


class MirrorLink:
    def __init__(self, driver: DeviceDriver) -> None:
        self.driver = driver
        self.info: Optional[DeviceInfo] = driver.info
        self.error: Optional[str] = None
        self.sent = 0
        self._busy = False
        self._pending: Optional[tuple] = None  # ("set", lat, lon) or ("clear",): only the newest counts
        self._wake = asyncio.Event()
        self._task = asyncio.create_task(self._run())

    @property
    def lost(self) -> bool:
        return self.error is not None

    def push_set(self, lat: float, lon: float) -> None:
        if not self.lost:
            self._pending = ("set", lat, lon)
            self._wake.set()

    def push_clear(self) -> None:
        if not self.lost:
            self._pending = ("clear",)
            self._wake.set()

    async def settle(self, timeout: float = 5.0) -> None:
        """Wait until the newest position has been sent (tests, and before removing a mirror)."""
        end = asyncio.get_running_loop().time() + timeout
        while (self._pending is not None or self._wake.is_set() or self._busy) and not self.lost:
            if asyncio.get_running_loop().time() > end:
                return
            await asyncio.sleep(0.01)
        await asyncio.sleep(0)

    async def _run(self) -> None:
        while True:
            await self._wake.wait()
            self._wake.clear()
            cmd, self._pending = self._pending, None
            if cmd is None:
                continue
            self._busy = True
            try:
                if cmd[0] == "set":
                    await asyncio.wait_for(self.driver.set_location(cmd[1], cmd[2]), SEND_TIMEOUT_S)
                else:
                    await asyncio.wait_for(self.driver.clear_location(), SEND_TIMEOUT_S)
                self.sent += 1
            except asyncio.CancelledError:
                raise
            except asyncio.TimeoutError:
                self.error = "The iPhone stopped answering."
                return
            except Exception as e:  # DeviceError or a transport failure: this mirror is lost
                self.error = str(e) or e.__class__.__name__
                return
            finally:
                self._busy = False

    async def close(self, clear: bool) -> None:
        """Stop following; with `clear`, the phone goes back to its real location first."""
        if clear and not self.lost:
            await self.settle(2.0)
        self._task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await self._task
        if clear and not self.lost:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self.driver.clear_location(), 10)
        with contextlib.suppress(Exception):
            await self.driver.disconnect()

    def to_dict(self) -> dict:
        d = self.info.to_dict() if self.info else {}
        d.update({"state": "lost" if self.lost else "ok", "error": self.error})
        return d


class FanOut(DeviceDriver):
    """What the player talks to: the main device, plus every mirror (without waiting for them)."""

    key = "fanout"
    label = "Main device and mirrors"

    def __init__(self, primary: Callable[[], DeviceDriver], mirrors: Callable[[], list[MirrorLink]]) -> None:
        # (no super().__init__(): `info` is the main device's, read through the property below)
        self._primary = primary
        self._mirrors = mirrors

    @property
    def info(self) -> Optional[DeviceInfo]:  # type: ignore[override]
        return self._primary().info

    @property
    def live(self) -> bool:  # type: ignore[override]
        return self._primary().live

    async def list_devices(self) -> list[dict]:
        return await self._primary().list_devices()

    async def connect(self, udid: Optional[str] = None, connection: str = "auto") -> DeviceInfo:
        raise DeviceError("Connect through the server")

    async def disconnect(self) -> None:
        await self._primary().disconnect()

    async def set_location(self, lat: float, lon: float) -> None:
        await self._primary().set_location(lat, lon)
        for m in self._mirrors():
            m.push_set(lat, lon)

    async def clear_location(self) -> None:
        await self._primary().clear_location()
        for m in self._mirrors():
            m.push_clear()

    async def play_gpx(self, path: str) -> None:
        await self._primary().play_gpx(path)

    async def stop_gpx(self) -> None:
        await self._primary().stop_gpx()

    async def reveal_developer_mode(self, udid: Optional[str] = None) -> str:
        return await self._primary().reveal_developer_mode(udid)

    async def mount_developer_image(self) -> str:
        return await self._primary().mount_developer_image()
