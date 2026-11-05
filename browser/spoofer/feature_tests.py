"""Feature tests: encrypted builds of the pull requests into ``feature-testing``, for the developer.

Same behaviour as the standalone app (feature_tests.rs). CI encrypts each build and an index of
builds with the developer password and uploads them to the ``feature-tests`` pre-release. Only the
password opens them (PBKDF2-HMAC-SHA256 key, AES-256-GCM, which also proves the files were made
with the password). A build is started as its own app, in its own window, with its own data
folder and port, and without self-updating.

File format: b"LSFT1" | iterations (u32, big-endian) | salt (16) | nonce (12) | ciphertext + tag.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import shutil
import struct
import subprocess
import sys
from pathlib import Path
from typing import Callable, Optional

import httpx
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

from .updater import REPO, USER_AGENT, independent_env

log = logging.getLogger(__name__)

RELEASE_TAG = "feature-tests"
MANIFEST = "ft-index.bin"
EXE_NAME = "LocationSpooferStandalone.exe"
MAGIC = b"LSFT1"
HEADER = 5 + 4 + 16 + 12
MAX_ITERATIONS = 5_000_000
ALLOWED_HOSTS = {"github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"}
_ASSET_RE = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$")


class FeatureTestError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def _key(password: str, salt: bytes, iterations: int) -> bytes:
    return PBKDF2HMAC(algorithm=SHA256(), length=32, salt=salt, iterations=iterations).derive(password.encode())


def seal(password: str, plain: bytes, iterations: int = 600_000) -> bytes:
    salt, nonce = os.urandom(16), os.urandom(12)
    return MAGIC + struct.pack(">I", iterations) + salt + nonce + AESGCM(_key(password, salt, iterations)).encrypt(nonce, plain, MAGIC)


def open_sealed(password: str, data: bytes) -> bytes:
    """Decrypt a feature-test file. Fails for a wrong password or a changed file."""
    if len(data) < HEADER + 16 or data[:5] != MAGIC:
        raise FeatureTestError(502, "This is not a feature-test file.")
    (iterations,) = struct.unpack(">I", data[5:9])
    if not 0 < iterations <= MAX_ITERATIONS:
        raise FeatureTestError(502, "This is not a feature-test file.")
    try:
        return AESGCM(_key(password, data[9:25], iterations)).decrypt(data[25:37], data[HEADER:], MAGIC)
    except InvalidTag:
        raise FeatureTestError(403, "Wrong password.") from None


def launch_process(exe: Path, args: list[str], data_dir: Path) -> None:
    """Start a downloaded build as its own app (Windows only: the builds are Windows programs)."""
    if sys.platform != "win32":
        raise FeatureTestError(400, "Feature-test builds are Windows apps. Open them on a Windows PC.")
    env = independent_env()  # not tied to this exe's unpack folder
    env["SPOOFER_DATA_DIR"] = str(data_dir)
    try:
        subprocess.Popen([str(exe), *args], cwd=str(exe.parent), env=env, close_fds=True)
    except OSError as e:
        raise FeatureTestError(502, f"Couldn't start the feature test: {e}") from None


Launcher = Callable[[Path, list, Path], None]


class FeatureTests:
    def __init__(self, data_dir: Path, repo: str = REPO, launcher: Launcher = launch_process,
                 transport: Optional[httpx.AsyncBaseTransport] = None) -> None:
        self.dir = data_dir / "feature-tests"
        self.repo = repo
        self.launcher = launcher
        self._transport = transport
        self._busy = asyncio.Lock()
        self._index: Optional[dict] = None  # the last index opened: "Open" needs no network then
        self._downloading: set[int] = set()
        self._prefetch: Optional[asyncio.Task] = None
        try:
            pw = self._key_file.read_text(encoding="utf-8").rstrip("\r\n")
        except OSError:
            pw = ""
        self.password: Optional[str] = pw or None

    @property
    def _key_file(self) -> Path:
        return self.dir / "access.key"

    async def _get(self, asset: str) -> bytes:
        url = f"https://github.com/{self.repo}/releases/download/{RELEASE_TAG}/{asset}"
        try:
            async with httpx.AsyncClient(timeout=300, follow_redirects=True, headers={"User-Agent": USER_AGENT},
                                         transport=self._transport) as c:
                r = await c.get(url)
        except httpx.HTTPError as e:
            raise FeatureTestError(502, f"Couldn't reach GitHub: {e}") from None
        if r.url.scheme != "https" or r.url.host not in ALLOWED_HOSTS:
            raise FeatureTestError(502, f"Refusing to download from {r.url.host}")
        if r.status_code == 404:
            raise FeatureTestError(404, "No feature-test builds have been published yet.")
        if r.status_code != 200:
            raise FeatureTestError(502, f"GitHub answered {r.status_code}.")
        return r.content

    async def _manifest(self, password: str) -> dict:
        plain = await asyncio.to_thread(open_sealed, password, await self._get(MANIFEST))
        try:
            m = json.loads(plain)
        except ValueError:
            raise FeatureTestError(502, "The feature-test index is damaged.") from None
        m = m if isinstance(m, dict) else {"builds": []}
        self._index = m
        return m

    def _files(self, b: dict) -> tuple[int, str, str, Path, Path]:
        pr, asset, total = b.get("pr"), b.get("asset"), str(b.get("sha256") or "").lower()
        if not isinstance(pr, int) or not isinstance(asset, str) or not _ASSET_RE.match(asset) \
                or not re.fullmatch(r"[0-9a-f]{64}", total):
            raise FeatureTestError(502, "The feature-test index is damaged.")
        folder = self.dir / "builds" / f"pr{pr}-{total[:12]}"
        return pr, asset, total, folder, folder / EXE_NAME

    def _ready(self, b: dict) -> bool:
        """Downloaded and checked: "verified" is written only after the checksum matched."""
        try:
            *_, folder, exe = self._files(b)
        except FeatureTestError:
            return False
        return exe.is_file() and (folder / "verified").is_file()

    async def _ensure(self, password: str, b: dict) -> Path:
        """The build's exe on disk, downloading, decrypting and checking it first if needed."""
        pr, asset, total, folder, exe = self._files(b)
        if self._ready(b):
            return exe
        plain = await asyncio.to_thread(open_sealed, password, await self._get(asset))
        if hashlib.sha256(plain).hexdigest() != total:
            raise FeatureTestError(502, "The downloaded build failed its checksum and was discarded.")
        builds = self.dir / "builds"
        if builds.is_dir():  # older builds of the same pull request (skipped while running)
            for old in builds.glob(f"pr{pr}-*"):
                if old != folder:
                    shutil.rmtree(old, ignore_errors=True)
        folder.mkdir(parents=True, exist_ok=True)
        tmp = folder / "download.part"
        tmp.write_bytes(plain)
        os.replace(tmp, exe)
        (folder / "verified").write_text(total, encoding="utf-8")
        return exe

    def _public(self, m: dict) -> dict:
        keys = ("pr", "title", "url", "state", "built_at", "version", "size")
        builds = [{**{k: b.get(k) for k in keys}, "ready": self._ready(b), "downloading": b.get("pr") in self._downloading}
                  for b in m.get("builds", []) if isinstance(b, dict)]
        return {"locked": False, "builds": builds}

    def _start_prefetch(self, password: str, m: dict) -> None:
        """Download every build that isn't on this computer yet, one at a time in the background,
        so "Open" starts them straight away."""
        todo = [b for b in m.get("builds", []) if isinstance(b, dict) and not self._ready(b)]
        if not todo or (self._prefetch and not self._prefetch.done()):
            return

        async def run() -> None:
            for b in todo:
                pr = b.get("pr")
                self._downloading.add(pr)
                try:
                    async with self._busy:
                        await self._ensure(password, b)
                except Exception as e:  # noqa: BLE001 - reported in the log; "Open" retries
                    log.warning("feature test #%s: %s", pr, e)
                finally:
                    self._downloading.discard(pr)

        self._prefetch = asyncio.get_running_loop().create_task(run())

    async def list(self) -> dict:
        """The list when unlocked (the password is in memory or remembered), else {"locked": True}."""
        if not self.password:
            return {"locked": True}
        m = await self._manifest(self.password)
        self._start_prefetch(self.password, m)
        return self._public(m)

    def progress(self) -> dict:
        """The list from the last index opened (no network): for showing download progress."""
        if not self.password:
            return {"locked": True}
        return self._public(self._index or {"builds": []})

    async def unlock(self, password: str, remember: bool) -> dict:
        if not password:
            raise FeatureTestError(400, "Enter the developer password.")
        m = await self._manifest(password)
        self.password = password
        if remember:
            self.dir.mkdir(parents=True, exist_ok=True)
            self._key_file.write_text(password, encoding="utf-8")
        self._start_prefetch(password, m)
        return self._public(m)

    def lock(self) -> None:
        self.password = None
        self._index = None
        try:
            self._key_file.unlink()
        except OSError:
            pass

    async def open_build(self, pr: int) -> dict:
        """Start a build in its own window (downloading it first if the background download hasn't)."""
        pw = self.password
        if not pw:
            raise FeatureTestError(400, "Unlock feature tests first.")

        def find(m: Optional[dict]) -> Optional[dict]:
            return next((x for x in (m or {}).get("builds", []) if isinstance(x, dict) and x.get("pr") == pr), None)

        b = find(self._index) or find(await self._manifest(pw))
        if b is None:
            raise FeatureTestError(404, "That feature test has no build.")
        async with self._busy:
            exe = await self._ensure(pw, b)
        self.launcher(exe, ["--port", "0", "--no-update", "--feature-test", str(pr)], self.dir / "data")
        return {"ok": True, "pr": pr, "title": b.get("title")}
