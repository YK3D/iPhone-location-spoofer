"""Fallback driver: runs the same `pymobiledevice3` commands the step-by-step guide uses.

Each command starts a new process (and on iOS 17+ a new tunnel), which takes a few seconds, so
this driver is not "live": routes are handed to `simulate-location play` as a GPX file instead
of being streamed point by point. Use it if the direct driver fails with your pymobiledevice3
version.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import signal
import sys
from typing import Optional

from .base import DeviceDriver, DeviceError, DeviceInfo

log = logging.getLogger(__name__)
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
IS_WINDOWS = sys.platform.startswith("win")


def _base_cmd() -> list[str]:
    return [sys.executable, "-m", "pymobiledevice3"]


def _env() -> dict[str, str]:
    env = dict(os.environ)
    env["PYTHONUNBUFFERED"] = "1"
    env["NO_COLOR"] = "1"
    env.setdefault("PYTHONIOENCODING", "utf-8")
    return env


async def _run(args: list[str], timeout: float = 90.0) -> str:
    proc = await asyncio.create_subprocess_exec(
        *_base_cmd(), *args,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        env=_env(),
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError as e:
        proc.kill()
        raise DeviceError(f"`pymobiledevice3 {' '.join(args)}` timed out") from e
    text = ANSI.sub("", out.decode("utf-8", "replace"))
    if proc.returncode != 0:
        raise DeviceError(_last_error(text) or f"pymobiledevice3 exited with code {proc.returncode}")
    return text


_LOG_PREFIX = re.compile(r"^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \S+ \S+\[\d+\] (\w+) ")


def _last_error(text: str) -> str:
    """The most useful line of pymobiledevice3 output: its last ERROR log line, else the last line."""
    lines = [ln.strip() for ln in text.strip().splitlines() if ln.strip()]
    for ln in reversed(lines):
        m = _LOG_PREFIX.match(ln)
        if m and m.group(1) in ("ERROR", "CRITICAL"):
            msg = ln[m.end():]
            if "usbmuxd" in msg:
                msg += " On Windows, open the Apple Devices app and keep it open."
            return msg[:400]
    for ln in reversed(lines):
        if not _LOG_PREFIX.match(ln) and ("Error" in ln or "Exception" in ln):
            return ln[:400]
    return _LOG_PREFIX.sub("", lines[-1])[:400] if lines else ""


class _Held:
    """A `set`/`play` process that keeps running until told to stop (it waits for Enter/SIGINT)."""

    def __init__(self, proc: asyncio.subprocess.Process):
        self.proc = proc
        self.output = ""

    async def wait_ready(self, timeout: float) -> None:
        """Return once the command reports it is waiting (location applied) - or fail."""
        assert self.proc.stdout is not None
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise DeviceError("Timed out waiting for the iPhone. Is it unlocked and connected?")
            try:
                chunk = await asyncio.wait_for(self.proc.stdout.read(512), remaining)
            except asyncio.TimeoutError as e:
                raise DeviceError("Timed out waiting for the iPhone. Is it unlocked and connected?") from e
            if not chunk:  # process ended
                await self.proc.wait()
                text = ANSI.sub("", self.output)
                if self.proc.returncode == 0:
                    return
                raise DeviceError(_last_error(text) or f"pymobiledevice3 exited with code {self.proc.returncode}")
            self.output += chunk.decode("utf-8", "replace")
            if "Press ENTER" in self.output or "Press Ctrl+C" in self.output:
                asyncio.create_task(self._drain())
                return

    async def _drain(self) -> None:
        try:
            while self.proc.stdout and await self.proc.stdout.read(4096):
                pass
        except Exception:
            pass

    @property
    def running(self) -> bool:
        return self.proc.returncode is None

    async def stop(self) -> None:
        if self.proc.returncode is not None:
            return
        try:
            if IS_WINDOWS and self.proc.stdin is not None:
                self.proc.stdin.write(b"\n")
                await self.proc.stdin.drain()
            else:
                self.proc.send_signal(signal.SIGINT)
            await asyncio.wait_for(self.proc.wait(), 5)
        except (asyncio.TimeoutError, ProcessLookupError, BrokenPipeError, ConnectionResetError, OSError):
            try:
                self.proc.kill()
            except ProcessLookupError:
                pass


class CliDriver(DeviceDriver):
    key = "cli"
    label = "Guide commands (pymobiledevice3 CLI)"
    live = False

    def __init__(self) -> None:
        super().__init__()
        self._held: Optional[_Held] = None
        self._dvt = True

    def _udid_args(self) -> list[str]:
        return ["--udid", self.info.udid] if self.info and self.info.udid else []

    def _sim_cmd(self) -> list[str]:
        return ["developer", "dvt", "simulate-location"] if self._dvt else ["developer", "simulate-location"]

    async def list_devices(self) -> list[dict]:
        text = await _run(["usbmux", "list"], timeout=60)
        start = text.find("[")
        try:
            data = json.loads(text[start:]) if start >= 0 else []
        except json.JSONDecodeError as e:
            raise DeviceError(f"Unexpected output from `usbmux list`: {text[:200]}") from e
        return [
            {
                "udid": d.get("Identifier") or d.get("UniqueDeviceID") or "",
                "name": d.get("DeviceName") or "",
                "ios_version": d.get("ProductVersion") or "",
                "connection": d.get("ConnectionType") or "USB",
            }
            for d in data
            if isinstance(d, dict)
        ]

    async def connect(self, udid: Optional[str] = None) -> DeviceInfo:
        devices = await self.list_devices()
        if not devices:
            raise DeviceError("No iPhone found. Plug it in, unlock it, tap Trust and keep the Apple Devices app open.")
        dev = next((d for d in devices if d["udid"] == udid), devices[0]) if udid else devices[0]
        try:
            major = int((dev["ios_version"] or "0").split(".")[0])
        except ValueError:
            major = 0
        self._dvt = major >= 17 or major == 0
        self.info = DeviceInfo(
            udid=dev["udid"],
            name=dev["name"] or "iPhone",
            ios_version=dev["ios_version"],
            connection=dev["connection"],
            transport="pymobiledevice3 CLI (" + " ".join(self._sim_cmd()) + ")",
            notes=["Each location change starts a new pymobiledevice3 process and takes a few seconds."],
        )
        return self.info

    async def disconnect(self) -> None:
        await self._stop_held()
        self.info = None

    async def _stop_held(self) -> None:
        held, self._held = self._held, None
        if held is not None:
            await held.stop()

    async def _start_held(self, args: list[str], timeout: float) -> None:
        await self._stop_held()
        proc = await asyncio.create_subprocess_exec(
            *_base_cmd(), *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=_env(),
        )
        held = _Held(proc)
        self._held = held
        await held.wait_ready(timeout)

    async def set_location(self, lat: float, lon: float) -> None:
        if not self.connected:
            raise DeviceError("Not connected")
        args = [*self._sim_cmd(), "set", *self._udid_args(), "--", f"{lat:.7f}", f"{lon:.7f}"]
        if self._dvt:
            await self._start_held(args, timeout=90)
        else:
            await self._stop_held()
            await _run(args)

    async def clear_location(self) -> None:
        if not self.connected:
            raise DeviceError("Not connected")
        await self._stop_held()
        await _run([*self._sim_cmd(), "clear", *self._udid_args()])

    async def play_gpx(self, path: str) -> None:
        if not self.connected:
            raise DeviceError("Not connected")
        args = [*self._sim_cmd(), "play", *self._udid_args(), path]
        if not self._dvt:
            args.append("0")  # the iOS<17 command requires timing_randomness_range
        await self._stop_held()
        proc = await asyncio.create_subprocess_exec(
            *_base_cmd(), *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=_env(),
        )
        self._held = _Held(proc)
        asyncio.create_task(self._held._drain())

    async def stop_gpx(self) -> None:
        await self._stop_held()

    async def reveal_developer_mode(self, udid: Optional[str] = None) -> str:
        await _run(["amfi", "reveal-developer-mode", *self._udid_args()])
        return "Done. On the iPhone open Settings > Privacy & Security > Developer Mode, switch it on and restart."

    async def mount_developer_image(self) -> str:
        text = await _run(["mounter", "auto-mount", *self._udid_args()], timeout=300)
        return _last_error(text) or "Developer Disk Image mounted."
