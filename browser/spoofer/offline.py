"""Offline maps: a local cache in front of OpenFreeMap, and downloads of map areas into it.

Same behaviour as the standalone app (offline.rs). The page loads OpenFreeMap through
``/ofm/<path>``, so the map can come from the cache when there is no internet. Only areas the user
downloads are stored tile by tile; styles, sprites and fonts are kept whenever they are fetched.

OpenFreeMap's terms allow offline downloads of at most 3,000 tiles or 50 MB each, with at most 4
parallel requests and a User-Agent that names the app.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import secrets
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx

from . import __version__

UPSTREAM = "https://tiles.openfreemap.org/"
MAX_TILES = 3000
MAX_BYTES = 50 * 1024 * 1024
PARALLEL = 4
VECTOR_MAX_ZOOM = 14  # OpenFreeMap's vector tiles stop here; closer zooms are drawn from them
RELIEF_MAX_ZOOM = 6  # the shaded-relief raster in the styles
STYLES = ("styles/dark", "styles/liberty")
GLYPH_RANGES = ("0-255", "256-511", "512-767", "768-1023", "1024-1279", "8192-8447", "8448-8703")
RELIEF_PREFIX = "natural_earth/ne2sr/"
TILE_PREFIX = "planet-tiles/"
USER_AGENT = f"LocationSpoofer/{__version__} (+https://github.com/YK3D/iPhone-location-spoofer)"
_ALLOWED = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-/%@,")
# 1x1 transparent PNG: answer for a relief tile that is neither cached nor reachable
EMPTY_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d49444154789c6300010000050001"
    "0d0a2db40000000049454e44ae426082"
)


@dataclass(frozen=True)
class Bounds:
    south: float
    west: float
    north: float
    east: float

    def validated(self) -> "Bounds":
        vals = (self.south, self.west, self.north, self.east)
        if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in vals):
            raise ValueError("Choose an area on the map first.")
        b = Bounds(
            south=min(max(self.south, -85.0511), 85.0511),
            west=min(max(self.west, -180.0), 180.0),
            north=min(max(self.north, -85.0511), 85.0511),
            east=min(max(self.east, -180.0), 180.0),
        )
        if b.south >= b.north or b.west >= b.east:
            raise ValueError("Choose an area on the map first.")
        return b


def tile_xy(lat: float, lon: float, z: int) -> tuple[int, int]:
    """Tile column and row of a point at zoom z (Web Mercator, as the map uses)."""
    n = float(1 << z)
    lat_r = math.radians(min(max(lat, -85.0511), 85.0511))
    x = math.floor((lon + 180.0) / 360.0 * n)
    y = math.floor((1.0 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2.0 * n)
    return int(min(max(x, 0), n - 1)), int(min(max(y, 0), n - 1))


def tiles(b: Bounds, min_z: int, max_z: int) -> list[tuple[int, int, int]]:
    out = []
    for z in range(min_z, max_z + 1):
        x0, y0 = tile_xy(b.north, b.west, z)
        x1, y1 = tile_xy(b.south, b.east, z)
        out += [(z, x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]
    return out


def tile_count(b: Bounds, min_z: int, max_z: int) -> int:
    total = 0
    for z in range(min_z, max_z + 1):
        x0, y0 = tile_xy(b.north, b.west, z)
        x1, y1 = tile_xy(b.south, b.east, z)
        total += (x1 - x0 + 1) * (y1 - y0 + 1)
    return total


def area_tiles(b: Bounds, min_z: int, max_z: int):
    """Vector tiles plus shaded-relief tiles needed for an area."""
    max_z = min(max_z, VECTOR_MAX_ZOOM)
    relief = tiles(b, min_z, min(max_z, RELIEF_MAX_ZOOM)) if min_z <= RELIEF_MAX_ZOOM else []
    return tiles(b, min_z, max_z), relief


def area_tile_count(b: Bounds, min_z: int, max_z: int) -> int:
    max_z = min(max_z, VECTOR_MAX_ZOOM)
    relief = tile_count(b, min_z, min(max_z, RELIEF_MAX_ZOOM)) if min_z <= RELIEF_MAX_ZOOM else 0
    return tile_count(b, min_z, max_z) + relief


def cache_key(path: str) -> Optional[tuple[str, str]]:
    """(cache file, kind) for a request path; kind is "tile", "static" or "fresh". None for paths
    that are not part of the map or try to leave the cache folder."""
    if not path or len(path) > 300 or path.startswith("/"):
        return None
    parts = path.split("/")
    if any(p in ("", ".", "..") for p in parts) or not set(path) <= _ALLOWED:
        return None
    if parts[0] == "planet" and len(parts) == 5 and parts[4].endswith(".pbf"):
        # planet/<version>/z/x/y.pbf: kept without the weekly version, so areas survive updates
        return f"{TILE_PREFIX}{parts[2]}/{parts[3]}/{parts[4]}", "tile"
    if parts == ["planet"]:
        return "planet.json", "fresh"
    if parts[0] == "styles" and len(parts) == 2:
        return f"{path}.json", "fresh"
    if parts[0] == "natural_earth":
        return path, "tile"
    if parts[0] in ("sprites", "fonts"):
        return path, "static"
    return None


def content_type(key: str) -> str:
    if key.endswith(".pbf"):
        return "application/x-protobuf"
    if key.endswith(".png"):
        return "image/png"
    return "application/json"


@dataclass
class Job:
    running: bool = False
    name: str = ""
    done: int = 0
    total: int = 0
    bytes: int = 0
    error: Optional[str] = None
    finished: Optional[str] = None


class Offline:
    def __init__(self, data_dir: Path, transport: Optional[httpx.AsyncBaseTransport] = None) -> None:
        self.dir = data_dir / "offline"
        self.job = Job()
        self._cancel = False
        self._transport = transport
        self._areas_lock = threading.Lock()
        self._task: Optional[asyncio.Task] = None

    # ------------------------------------------------------------ cache files
    def _file(self, key: str) -> Path:
        return self.dir / "cache" / key

    def _read(self, key: str) -> Optional[bytes]:
        try:
            return self._file(key).read_bytes()
        except OSError:
            return None

    def _write(self, key: str, data: bytes) -> None:
        f = self._file(key)
        try:
            f.parent.mkdir(parents=True, exist_ok=True)
            tmp = f.with_name(f.name + ".part")
            tmp.write_bytes(data)
            os.replace(tmp, f)
        except OSError:
            pass

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=20, headers={"User-Agent": USER_AGENT}, transport=self._transport)

    async def _fetch(self, client: httpx.AsyncClient, path: str) -> bytes:
        try:
            r = await client.get(UPSTREAM + path)
        except httpx.HTTPError as e:
            raise RuntimeError(str(e) or e.__class__.__name__) from None
        if r.status_code != 200:
            raise RuntimeError(f"OpenFreeMap answered {r.status_code}")
        return r.content

    async def proxy(self, path: str) -> tuple[int, str, bytes]:
        """Answer a map request from the page: (status, content type, body)."""
        ck = cache_key(path)
        if ck is None:
            return 404, "text/plain", b"not a map file"
        key, kind = ck
        ct = content_type(key)
        cached = self._read(key)
        if kind in ("tile", "static") and cached is not None:
            return 200, ct, cached
        async with self._client() as client:
            try:
                body = await self._fetch(client, path)
            except RuntimeError as e:
                if kind == "tile":
                    # offline and not downloaded: an empty tile, so the map shows what it has
                    return 200, ct, EMPTY_PNG if ct == "image/png" else b""
                if kind == "fresh" and cached is not None:
                    return 200, ct, cached
                return 502, "text/plain", str(e).encode()
        if kind != "tile":
            self._write(key, body)
        return 200, ct, body

    # ------------------------------------------------------------ areas
    @property
    def _areas_file(self) -> Path:
        return self.dir / "areas.json"

    def areas(self) -> list[dict]:
        try:
            v = json.loads(self._areas_file.read_text(encoding="utf-8"))
            return v if isinstance(v, list) else []
        except (OSError, ValueError):
            return []

    def _save_areas(self, areas: list[dict]) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        tmp = self._areas_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(areas, indent=1), encoding="utf-8")
        os.replace(tmp, self._areas_file)

    @staticmethod
    def _area_bounds(a: dict):
        try:
            b = Bounds(float(a["south"]), float(a["west"]), float(a["north"]), float(a["east"]))
            return b, int(a["min_zoom"]), int(a["max_zoom"])
        except (KeyError, TypeError, ValueError):
            return None

    def collect_garbage(self) -> None:
        """Delete stored tiles that no saved area needs any more."""
        with self._areas_lock:
            keep: set[str] = set()
            for a in self.areas():
                ab = self._area_bounds(a)
                if ab:
                    vec, relief = area_tiles(*ab)
                    keep |= {f"{TILE_PREFIX}{z}/{x}/{y}.pbf" for z, x, y in vec}
                    keep |= {f"{RELIEF_PREFIX}{z}/{x}/{y}.png" for z, x, y in relief}
            root = self.dir / "cache"
            for prefix in (TILE_PREFIX, RELIEF_PREFIX):
                base = root / prefix
                if not base.is_dir():
                    continue
                for p in base.rglob("*"):
                    if p.is_file() and p.relative_to(root).as_posix() not in keep:
                        try:
                            p.unlink()
                        except OSError:
                            pass

    def delete_area(self, area_id: str) -> None:
        with self._areas_lock:
            areas = self.areas()
            left = [a for a in areas if a.get("id") != area_id]
            if len(left) == len(areas):
                raise LookupError("That offline area no longer exists.")
            self._save_areas(left)
        self.collect_garbage()

    def status(self) -> dict:
        j = self.job
        return {
            "areas": self.areas(),
            "job": {"running": j.running, "name": j.name, "done": j.done, "total": j.total, "bytes": j.bytes,
                    "error": j.error, "finished": j.finished},
            "limits": {"max_tiles": MAX_TILES, "max_bytes": MAX_BYTES, "max_zoom": VECTOR_MAX_ZOOM},
        }

    @staticmethod
    def estimate(b: Bounds, min_z: int, max_z: int) -> dict:
        b = b.validated()
        n = area_tile_count(b, min_z, min(max_z, VECTOR_MAX_ZOOM))
        return {"tiles": n, "max_tiles": MAX_TILES, "ok": n <= MAX_TILES}

    def cancel(self) -> None:
        self._cancel = True

    def start(self, name: Optional[str], bounds: Bounds, min_zoom: Optional[int], max_zoom: int) -> dict:
        """Check the request and start downloading in the background."""
        b = bounds.validated()
        max_z = max(0, min(int(max_zoom), VECTOR_MAX_ZOOM))
        min_z = max(0, min(int(min_zoom or 0), max_z))
        total = area_tile_count(b, min_z, max_z)
        if total > MAX_TILES:
            raise ValueError(
                f"This area needs {total} map tiles; OpenFreeMap allows {MAX_TILES} per download. "
                "Zoom in on a smaller area or lower the detail."
            )
        name = (name or "").strip()[:60] or f"Area {(b.south + b.north) / 2:.3f}, {(b.west + b.east) / 2:.3f}"
        if self.job.running:
            raise RuntimeError("A download is already running.")
        self.job = Job(running=True, name=name, total=total)
        self._cancel = False
        self._task = asyncio.get_running_loop().create_task(self._run(name, b, min_z, max_z))
        return self.status()

    async def _run(self, name: str, b: Bounds, min_z: int, max_z: int) -> None:
        try:
            await self._download(name, b, min_z, max_z)
            self.job.finished = name
        except Exception as e:  # reported to the page
            self.job.error = str(e) or e.__class__.__name__
            await asyncio.to_thread(self.collect_garbage)  # tiles of a failed download belong to no area
        finally:
            self.job.running = False

    def _add_bytes(self, n: int) -> None:
        self.job.bytes += n
        if self.job.bytes > MAX_BYTES:
            raise RuntimeError("The download passed OpenFreeMap's 50 MB limit and was stopped. Choose a smaller area or less detail.")

    async def _keep(self, client: httpx.AsyncClient, path: str, key: str) -> None:
        if self._cancel:
            raise RuntimeError("Download cancelled.")
        body = await self._fetch(client, path)
        self._add_bytes(len(body))
        self._write(key, body)

    async def _download(self, name: str, b: Bounds, min_z: int, max_z: int) -> None:
        async with self._client() as client:
            # the tile index (it names this week's tile folder), both styles, their sprites and fonts
            try:
                raw = await self._fetch(client, "planet")
            except RuntimeError as e:
                raise RuntimeError(f"Couldn't reach OpenFreeMap: {e}") from None
            self._write("planet.json", raw)
            try:
                template = json.loads(raw)["tiles"][0]
            except (ValueError, KeyError, IndexError, TypeError):
                raise RuntimeError("OpenFreeMap sent an unexpected tile index.") from None
            if not isinstance(template, str) or not template.startswith(UPSTREAM) or "{z}" not in template:
                raise RuntimeError("OpenFreeMap sent an unexpected tile index.")
            tile_path = template[len(UPSTREAM):]
            extra: set[str] = set()
            for style in STYLES:
                body = await self._fetch(client, style)
                self._write(style + ".json", body)
                try:
                    s = json.loads(body)
                except ValueError:
                    raise RuntimeError("OpenFreeMap sent an unexpected map style.") from None
                sprite = s.get("sprite")
                if isinstance(sprite, str) and sprite.startswith(UPSTREAM):
                    extra |= {sprite[len(UPSTREAM):] + sfx for sfx in (".json", ".png", "@2x.json", "@2x.png")}
                glyphs = s.get("glyphs")
                if isinstance(glyphs, str) and glyphs.startswith(UPSTREAM):
                    stacks = set()
                    for layer in s.get("layers", []):
                        f = (layer.get("layout") or {}).get("text-font")
                        if isinstance(f, list) and f and all(isinstance(x, str) for x in f):
                            stacks.add(",".join(f))
                    for stack in stacks:
                        enc = stack.replace(" ", "%20")  # as the page's fetch() sends it
                        extra |= {glyphs[len(UPSTREAM):].replace("{fontstack}", enc).replace("{range}", r) for r in GLYPH_RANGES}
            for p in sorted(extra):
                ck = cache_key(p)
                if ck and self._read(ck[0]) is None:
                    await self._keep(client, p, ck[0])
            # the tiles, at most 4 at a time
            vector, relief = area_tiles(b, min_z, max_z)
            jobs = [(tile_path.replace("{z}", str(z)).replace("{x}", str(x)).replace("{y}", str(y)), f"{TILE_PREFIX}{z}/{x}/{y}.pbf")
                    for z, x, y in vector]
            jobs += [(f"{RELIEF_PREFIX}{z}/{x}/{y}.png",) * 2 for z, x, y in relief]
            queue: asyncio.Queue = asyncio.Queue()
            for j in jobs:
                queue.put_nowait(j)

            async def worker() -> None:
                while True:
                    try:
                        path, key = queue.get_nowait()
                    except asyncio.QueueEmpty:
                        return
                    if self._read(key) is None:
                        await self._keep(client, path, key)
                    self.job.done += 1

            workers = [asyncio.create_task(worker()) for _ in range(PARALLEL)]
            try:
                await asyncio.gather(*workers)
            except BaseException:
                self._cancel = True  # stop the other requests too
                for w in workers:
                    w.cancel()
                await asyncio.gather(*workers, return_exceptions=True)
                raise
        # the area's size on disk (tiles it shares with other areas are counted for each)
        size = 0
        for _, key in jobs:
            try:
                size += self._file(key).stat().st_size
            except OSError:
                pass
        area = {
            "id": secrets.token_hex(8), "name": name, "south": b.south, "west": b.west, "north": b.north,
            "east": b.east, "min_zoom": min_z, "max_zoom": max_z, "tiles": self.job.total, "bytes": size,
            "created": datetime.now(timezone.utc).isoformat(),
        }
        with self._areas_lock:
            self._save_areas(self.areas() + [area])
