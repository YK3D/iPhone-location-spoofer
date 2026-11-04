"""A pretend device, so the whole app can be tried (and tested) with no iPhone attached."""

from __future__ import annotations

from typing import Optional

from .base import DeviceDriver, DeviceError, DeviceInfo


# The pretend phones always report this iOS version (the current major release).
SIMULATED_IOS = "27"
# Two pretend phones, so several iPhones at once can be tried without hardware.
SIMULATED_DEVICES = {"SIMULATED-0001": "Simulated iPhone", "SIMULATED-0002": "Simulated iPhone 2"}


class MockDriver(DeviceDriver):
    key = "mock"
    label = "Simulator (no iPhone)"
    live = True

    def __init__(self) -> None:
        super().__init__()
        self.location: Optional[tuple[float, float]] = None
        self.history: list[tuple[float, float]] = []

    async def list_devices(self) -> list[dict]:
        return [{"udid": udid, "name": name, "ios_version": SIMULATED_IOS, "connection": "Simulated", "connections": ["Simulated"]}
                for udid, name in SIMULATED_DEVICES.items()]

    async def connect(self, udid: Optional[str] = None, connection: str = "auto") -> DeviceInfo:
        udid = udid or next(iter(SIMULATED_DEVICES))
        if udid not in SIMULATED_DEVICES:
            raise DeviceError("No such simulated iPhone")
        self.info = DeviceInfo(
            udid=udid,
            name=SIMULATED_DEVICES[udid],
            ios_version=SIMULATED_IOS,
            product_type="Simulated",
            connection="Simulated",
            transport="In-memory (nothing is sent to a phone)",
        )
        return self.info

    async def disconnect(self) -> None:
        self.info = None

    async def set_location(self, lat: float, lon: float) -> None:
        self.location = (lat, lon)
        self.history.append((lat, lon))
        if len(self.history) > 10_000:
            del self.history[:5_000]

    async def clear_location(self) -> None:
        self.location = None

    async def reveal_developer_mode(self, udid: Optional[str] = None) -> str:
        return "Simulator: nothing to reveal."

    async def mount_developer_image(self) -> str:
        return "Simulator: nothing to mount."

    async def enable_wifi(self, udid: Optional[str] = None) -> str:
        return "Simulator: nothing to do."
