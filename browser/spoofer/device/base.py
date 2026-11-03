"""Common interface for the ways this app can move an iPhone's location."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass, field
from typing import Optional


class DeviceError(Exception):
    """A problem talking to the device, with a message meant for the user."""


@dataclass
class DeviceInfo:
    udid: str
    name: str = "iPhone"
    ios_version: str = ""
    product_type: str = ""
    connection: str = ""  # USB / Network / Simulated
    transport: str = ""  # how location commands reach it (DVT tunnel, lockdown, CLI, ...)
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


class DeviceDriver(ABC):
    """`live` drivers can take a new location many times a second (needed for the in-app player,
    joystick and pause/resume). Non-live drivers fall back to handing a GPX file to the CLI."""

    key: str = "base"
    label: str = "Base"
    live: bool = True

    def __init__(self) -> None:
        self.info: Optional[DeviceInfo] = None

    @property
    def connected(self) -> bool:
        return self.info is not None

    @abstractmethod
    async def list_devices(self) -> list[dict]: ...

    @abstractmethod
    async def connect(self, udid: Optional[str] = None) -> DeviceInfo: ...

    @abstractmethod
    async def disconnect(self) -> None: ...

    @abstractmethod
    async def set_location(self, lat: float, lon: float) -> None: ...

    @abstractmethod
    async def clear_location(self) -> None: ...

    async def reveal_developer_mode(self, udid: Optional[str] = None) -> str:
        raise DeviceError("Not supported by this connection method")

    async def mount_developer_image(self) -> str:
        raise DeviceError("Not supported by this connection method")

    # Only used by non-live drivers
    async def play_gpx(self, path: str) -> None:
        raise DeviceError("Not supported by this connection method")

    async def stop_gpx(self) -> None:
        return None
