"""Tiny JSON store for favourites, saved routes and settings (one file in the user's home)."""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

DEFAULT = {"favorites": [], "routes": [], "settings": {}}


def data_dir() -> Path:
    base = os.environ.get("SPOOFER_DATA_DIR")
    if base:
        return Path(base)
    if os.name == "nt" and os.environ.get("APPDATA"):
        return Path(os.environ["APPDATA"]) / "iPhoneLocationSpoofer"
    return Path.home() / ".iphone-location-spoofer"


class Store:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or data_dir() / "data.json"
        self._lock = threading.Lock()

    def load(self) -> dict[str, Any]:
        with self._lock:
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
                if not isinstance(data, dict):
                    raise ValueError
            except (FileNotFoundError, ValueError):
                data = {}
        return {**DEFAULT, **data}

    def save(self, data: dict[str, Any]) -> dict[str, Any]:
        clean = {k: data.get(k, v) for k, v in DEFAULT.items()}
        for k in ("favorites", "routes"):
            if not isinstance(clean[k], list):
                raise ValueError(f"{k} must be a list")
        if not isinstance(clean["settings"], dict):
            raise ValueError("settings must be an object")
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(clean, indent=1), encoding="utf-8")
            os.replace(tmp, self.path)
        return clean
