"""Self-update for the Windows .exe build, using GitHub Releases of this repository.

Flow
----
1. A push to ``main`` makes GitHub Actions build ``LocationSpoofer.exe`` and publish it as a
   release (tag ``v<version>``) together with ``LocationSpoofer.exe.sha256``.
2. The running exe checks ``/releases/latest`` at start-up and every few hours. When the release
   is newer, it downloads the exe next to itself as ``LocationSpoofer.update.exe``, verifies the
   SHA-256 and records it in ``LocationSpoofer.update.json``.
3. The update is installed either when the user presses *Restart now* or automatically at the
   next launch: the running exe is renamed to ``LocationSpoofer.old.exe`` (Windows allows
   renaming a running exe, not overwriting it), the new file takes its name, and it is started.
   The new process deletes the ``.old.exe`` once the old one has exited.

Only the frozen build updates itself. Running from source, use ``git pull`` instead.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

import httpx

from . import __version__

log = logging.getLogger(__name__)

REPO = os.environ.get("SPOOFER_UPDATE_REPO", "YK3D/iPhone-location-spoofer")
ASSET = "LocationSpoofer.exe"
CHECK_EVERY_S = 6 * 3600
ALLOWED_HOSTS = ("github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com")
USER_AGENT = f"iPhone-Location-Spoofer/{__version__}"


def parse_version(text: str) -> tuple[int, ...]:
    """'v1.1.23' -> (1, 1, 23). Anything after the numbers (e.g. '-dev') is ignored."""
    m = re.match(r"^v?(\d+(?:\.\d+)*)", (text or "").strip())
    if not m:
        return ()
    return tuple(int(x) for x in m.group(1).split("."))


def is_newer(candidate: str, current: str) -> bool:
    c, cur = parse_version(candidate), parse_version(current)
    if not c:
        return False
    n = max(len(c), len(cur))
    return c + (0,) * (n - len(c)) > cur + (0,) * (n - len(cur))


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def independent_env() -> dict[str, str]:
    """Environment for starting a *separate* instance of a one-file PyInstaller exe.

    Without this, the new process inherits the bootloader's variables and tries to reuse this
    process's temporary unpack folder, which is deleted when this process exits (PyInstaller >= 6.9).
    """
    env = dict(os.environ)
    env["PYINSTALLER_RESET_ENVIRONMENT"] = "1"
    return env


class Updater:
    def __init__(
        self,
        exe_path: Optional[Path] = None,
        current: str = __version__,
        enabled: Optional[bool] = None,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ):
        self.exe = Path(exe_path or sys.executable).resolve()
        self._transport = transport
        self.current = current
        self.enabled = is_frozen() if enabled is None else enabled
        self.state = "idle" if self.enabled else "disabled"
        self.latest: Optional[str] = None
        self.notes = ""
        self.error: Optional[str] = None
        self.progress = 0.0
        self.checked_at: Optional[float] = None
        self._lock = asyncio.Lock()

    # ---------------------------------------------------------------- file locations
    @property
    def staged(self) -> Path:
        return self.exe.with_name(self.exe.stem + ".update.exe")

    @property
    def staged_meta(self) -> Path:
        return self.exe.with_name(self.exe.stem + ".update.json")

    @property
    def old(self) -> Path:
        return self.exe.with_name(self.exe.stem + ".old.exe")

    def status(self) -> dict:
        return {
            "enabled": self.enabled,
            "state": self.state,
            "current": self.current,
            "latest": self.latest,
            "notes": self.notes,
            "error": self.error,
            "progress": round(self.progress, 3),
            "checked_at": self.checked_at,
            "repo": REPO,
        }

    # ---------------------------------------------------------------- staged update
    def staged_version(self) -> Optional[str]:
        """Version of a fully downloaded, checksum-verified update waiting to be installed."""
        try:
            meta = json.loads(self.staged_meta.read_text(encoding="utf-8"))
            if not self.staged.exists() or sha256_file(self.staged) != meta["sha256"]:
                return None
            return meta["version"] if is_newer(meta["version"], self.current) else None
        except (OSError, ValueError, KeyError, TypeError):
            return None

    def discard_staged(self) -> None:
        for p in (self.staged, self.staged_meta, self.staged.with_suffix(".part")):
            try:
                p.unlink()
            except OSError:
                pass

    def cleanup_old(self, wait_s: float = 20.0) -> None:
        """Delete the previous exe once its process has exited (call from a background thread)."""
        deadline = time.time() + wait_s
        while self.old.exists() and time.time() < deadline:
            try:
                self.old.unlink()
            except OSError:
                time.sleep(0.5)
        # leftovers of an outdated or broken staged update
        if self.staged_meta.exists() and self.staged_version() is None:
            self.discard_staged()

    def swap_in_staged(self) -> bool:
        """Put the staged exe in place of the running one. Returns True if swapped."""
        version = self.staged_version()
        if not version:
            return False
        try:
            if self.old.exists():
                self.old.unlink()
            os.replace(self.exe, self.old)  # rename the running exe out of the way
        except OSError as e:
            self.error = f"Could not replace the program file ({e}). Move LocationSpoofer.exe to a folder you can write to, e.g. your Desktop."
            log.warning(self.error)
            return False
        try:
            os.replace(self.staged, self.exe)
        except OSError as e:
            os.replace(self.old, self.exe)  # roll back
            self.error = f"Could not install the update: {e}"
            log.warning(self.error)
            return False
        try:
            self.staged_meta.unlink()
        except OSError:
            pass
        log.info("Installed update %s", version)
        return True

    def relaunch(self, args: list[str]) -> None:
        """Start the (new) exe, telling it to wait until this process has exited."""
        clean: list[str] = []
        skip = False
        for a in args:
            if skip:
                skip = False
            elif a == "--wait-pid":
                skip = True
            elif not a.startswith("--wait-pid="):
                clean.append(a)
        cmd = [str(self.exe), *clean, "--wait-pid", str(os.getpid())]
        subprocess.Popen(cmd, close_fds=True, env=independent_env())

    # ---------------------------------------------------------------- network
    async def check(self, download: bool = True) -> dict:
        if not self.enabled:
            return self.status()
        if self._lock.locked():
            return self.status()
        async with self._lock:
            self.error = None
            self.state = "checking"
            try:
                async with httpx.AsyncClient(
                    timeout=30, follow_redirects=True, headers={"User-Agent": USER_AGENT}, transport=self._transport
                ) as client:
                    r = await client.get(
                        f"https://api.github.com/repos/{REPO}/releases/latest",
                        headers={"Accept": "application/vnd.github+json"},
                    )
                    if r.status_code == 404:
                        self.state = "up_to_date"
                        self.checked_at = time.time()
                        return self.status()
                    r.raise_for_status()
                    rel = r.json()
                    tag = rel.get("tag_name", "")
                    self.latest = tag.lstrip("v")
                    self.notes = (rel.get("body") or "")[:2000]
                    self.checked_at = time.time()
                    if not is_newer(tag, self.current):
                        self.state = "up_to_date"
                        return self.status()
                    if self.staged_version() == self.latest:
                        self.state = "ready"
                        return self.status()
                    if not download:
                        self.state = "available"
                        return self.status()
                    assets = {a.get("name"): a.get("browser_download_url") for a in rel.get("assets", [])}
                    exe_url, sum_url = assets.get(ASSET), assets.get(ASSET + ".sha256")
                    if not exe_url or not sum_url:
                        raise RuntimeError(f"Release {tag} has no {ASSET} and checksum file")
                    for u in (exe_url, sum_url):
                        _check_url(u)
                    s = await client.get(sum_url)
                    s.raise_for_status()
                    expected = s.text.strip().split()[0].lower()
                    if not re.fullmatch(r"[0-9a-f]{64}", expected):
                        raise RuntimeError("The release checksum file is malformed")
                    self.state = "downloading"
                    await self._download(client, exe_url, expected, self.latest)
                    self.state = "ready"
            except Exception as e:
                log.warning("update check failed: %r", e)
                self.error = str(e) or e.__class__.__name__
                self.state = "error"
            return self.status()

    async def _download(self, client: httpx.AsyncClient, url: str, expected: str, version: str) -> None:
        part = self.staged.with_suffix(".part")
        h = hashlib.sha256()
        self.progress = 0.0
        async with client.stream("GET", url) as r:
            r.raise_for_status()
            _check_url(str(r.url))
            total = int(r.headers.get("content-length") or 0)
            done = 0
            with open(part, "wb") as f:
                async for chunk in r.aiter_bytes(1 << 16):
                    f.write(chunk)
                    h.update(chunk)
                    done += len(chunk)
                    if total:
                        self.progress = done / total
        if h.hexdigest() != expected:
            part.unlink(missing_ok=True)
            raise RuntimeError("Downloaded update failed the SHA-256 check and was discarded")
        os.replace(part, self.staged)
        self.staged_meta.write_text(json.dumps({"version": version, "sha256": expected}), encoding="utf-8")
        self.progress = 1.0

    async def run_periodically(self) -> None:
        if not self.enabled:
            return
        await asyncio.sleep(5)  # let the app finish starting
        while True:
            await self.check()
            await asyncio.sleep(CHECK_EVERY_S)


def _check_url(url: str) -> None:
    u = httpx.URL(url)
    if u.scheme != "https" or u.host not in ALLOWED_HOSTS:
        raise RuntimeError(f"Refusing to download an update from {u.host!r}")
