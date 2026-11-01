"""Path-finding between two waypoints for each travel mode.

* car / bike / foot - OpenStreetMap road network via public OSRM servers
  (routing.openstreetmap.de, run by the FOSSGIS association). Needs internet.
* sea - shipping lanes from the offline `searoute` marine network (no internet needed).
* straight - great-circle line (flights, off-road, open water).
"""

from __future__ import annotations

import asyncio
import os
from functools import lru_cache
from typing import Optional

import httpx

from . import geo

USER_AGENT = "iPhone-Location-Spoofer/1.0 (local desktop app)"

OSRM_URLS = {
    "car": os.environ.get("SPOOFER_OSRM_CAR", "https://routing.openstreetmap.de/routed-car"),
    "bike": os.environ.get("SPOOFER_OSRM_BIKE", "https://routing.openstreetmap.de/routed-bike"),
    "foot": os.environ.get("SPOOFER_OSRM_FOOT", "https://routing.openstreetmap.de/routed-foot"),
}
NOMINATIM_URL = os.environ.get("SPOOFER_NOMINATIM", "https://nominatim.openstreetmap.org")

MODES = ("car", "bike", "foot", "sea", "straight")


class RoutingError(Exception):
    pass


_client: Optional[httpx.AsyncClient] = None
_cache: dict[tuple, list[geo.LatLon]] = {}


def client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=20.0, headers={"User-Agent": USER_AGENT}, follow_redirects=True)
    return _client


async def close() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


async def route(a: geo.LatLon, b: geo.LatLon, mode: str) -> list[geo.LatLon]:
    """Path from a to b as (lat, lon) points, starting at a and ending at b."""
    if mode not in MODES:
        raise RoutingError(f"Unknown travel mode {mode!r}")
    key = (round(a[0], 6), round(a[1], 6), round(b[0], 6), round(b[1], 6), mode)
    if key in _cache:
        return _cache[key]
    if mode == "straight" or geo.haversine_m(a, b) < 1.0:
        pts = [a, b]
    elif mode == "sea":
        pts = await asyncio.to_thread(_sea_route, a, b)
    else:
        pts = await _osrm_route(a, b, mode)
    if len(_cache) > 500:
        _cache.clear()
    _cache[key] = pts
    return pts


async def _osrm_route(a: geo.LatLon, b: geo.LatLon, mode: str) -> list[geo.LatLon]:
    base = OSRM_URLS[mode].rstrip("/")
    url = f"{base}/route/v1/driving/{a[1]:.6f},{a[0]:.6f};{b[1]:.6f},{b[0]:.6f}"
    try:
        r = await client().get(url, params={"overview": "full", "geometries": "geojson"})
    except httpx.HTTPError as e:
        raise RoutingError(f"Could not reach the {mode} routing server ({e.__class__.__name__}). Check your internet connection or use 'straight'.") from e
    if r.status_code == 429:
        raise RoutingError("The routing server is rate-limiting requests. Wait a moment and try again.")
    try:
        data = r.json()
    except ValueError as e:
        raise RoutingError(f"Routing server returned HTTP {r.status_code}") from e
    if data.get("code") != "Ok" or not data.get("routes"):
        raise RoutingError(f"No {mode} route found: {data.get('message') or data.get('code')}")
    coords = data["routes"][0]["geometry"]["coordinates"]
    pts = [(lat, lon) for lon, lat in coords]
    # OSRM snaps to the nearest road; join the real waypoints to the snapped path.
    return [a, *pts, b]


@lru_cache(maxsize=1)
def _searoute_module():
    try:
        import searoute  # type: ignore

        return searoute
    except ImportError as e:  # pragma: no cover - dependency is in requirements.txt
        raise RoutingError("Sea routing needs the 'searoute' package: pip install searoute") from e


def _sea_route(a: geo.LatLon, b: geo.LatLon) -> list[geo.LatLon]:
    sr = _searoute_module()
    try:
        feat = sr.searoute([a[1], a[0]], [b[1], b[0]])
    except Exception as e:  # searoute raises plain exceptions for unreachable points
        raise RoutingError(f"No sea route found: {e}") from e
    coords = feat.geometry["coordinates"]
    pts = [(lat, lon) for lon, lat in coords]
    # The marine network ends at the nearest lane node; connect to the actual points.
    return [a, *_unwrap_antimeridian(pts), b]


def _unwrap_antimeridian(pts: list[geo.LatLon]) -> list[geo.LatLon]:
    """Normalise longitudes into -180..180 (searoute can return values just outside)."""
    return [(lat, ((lon + 180.0) % 360.0) - 180.0) for lat, lon in pts]


async def geocode(query: str, limit: int = 6) -> list[dict]:
    """Place search (OpenStreetMap Nominatim). Their policy: max 1 request/second, so the UI only
    searches when the user presses Enter."""
    q = query.strip()
    if not q:
        return []
    try:
        r = await client().get(
            f"{NOMINATIM_URL}/search", params={"q": q, "format": "jsonv2", "limit": limit}
        )
        r.raise_for_status()
    except httpx.HTTPError as e:
        raise RoutingError(f"Place search failed: {e}") from e
    return [
        {"name": item.get("display_name", ""), "lat": float(item["lat"]), "lon": float(item["lon"])}
        for item in r.json()
    ]


async def reverse_geocode(lat: float, lon: float) -> Optional[str]:
    try:
        r = await client().get(
            f"{NOMINATIM_URL}/reverse", params={"lat": lat, "lon": lon, "format": "jsonv2", "zoom": 16}
        )
        r.raise_for_status()
        return r.json().get("display_name")
    except (httpx.HTTPError, ValueError):
        return None
