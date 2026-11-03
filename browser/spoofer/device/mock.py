"""A pretend device, so the whole app can be tried (and tested) with no iPhone attached."""

from __future__ import annotations

from typing import Optional

from .base import DeviceDriver, DeviceInfo


# The pretend phone always reports this iOS version (the current major release).
SIMULATED_IOS = "27"


class MockDriver(DeviceDriver):
    key = "mock"
    label = "Simulator (no iPhone)"
    live = True

    def __init__(self) -> None:
        super().__init__()
        self.location: Optional[tuple[float, float]] = None
        self.history: list[tuple[float, float]] = []

    async def list_devices(self) -> list[dict]:
        return [{"udid": "SIMULATED-0001", "name": "Simulated iPhone", "ios_version": SIMULATED_IOS, "connection": "Simulated"}]

    async def connect(self, udid: Optional[str] = None) -> DeviceInfo:
        self.info = DeviceInfo(
            udid="SIMULATED-0001",
            name="Simulated iPhone",
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
