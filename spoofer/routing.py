"""Path-finding between two waypoints for each travel mode.

Providers:
* ``osrm`` (default) - OpenStreetMap road network via public OSRM servers
  (routing.openstreetmap.de, run by the FOSSGIS association). Needs internet.
* ``google`` - Google Routes API with the user's own API key (see google_api.py).
* sea - shipping lanes from the offline `searoute` marine network (no internet needed).
* straight - great-circle line (flights, off-road, open water).

Every result also carries what the experimental road-aware speed model needs: the provider's
own per-segment speeds ("zones"), its ETA, and notable road features.
"""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Optional

import httpx

from . import geo, google_api, road_speed

log = logging.getLogger(__name__)
USER_AGENT = "iPhone-Location-Spoofer/1.0 (local desktop app)"

OSRM_URLS = {
    "car": os.environ.get("SPOOFER_OSRM_CAR", "https://routing.openstreetmap.de/routed-car"),
    "bike": os.environ.get("SPOOFER_OSRM_BIKE", "https://routing.openstreetmap.de/routed-bike"),
    "foot": os.environ.get("SPOOFER_OSRM_FOOT", "https://routing.openstreetmap.de/routed-foot"),
}
NOMINATIM_URL = os.environ.get("SPOOFER_NOMINATIM", "https://nominatim.openstreetmap.org")

MODES = ("car", "bike", "foot", "sea", "straight")
ROAD_MODES = ("car", "bike", "foot")
OFFNET_MIN_M = 25.0  # a gap this long between the waypoint and the road network is "off-network"


class RoutingError(Exception):
    pass


@dataclass
class RouteResult:
    points: list[geo.LatLon]  # starts exactly at a, ends exactly at b
    provider: str = "straight"  # osrm | google | searoute | straight
    zones: Optional[list[tuple[float, Optional[float]]]] = None  # (end distance m, typical speed m/s)
    ref_duration_s: Optional[float] = None  # the provider's own ETA for this leg
    features: dict = field(default_factory=dict)  # counts / lengths of notable road features
    notes: list[str] = field(default_factory=list)
    exportable: bool = True  # False for Google results (caching/export restricted)


_client: Optional[httpx.AsyncClient] = None
_cache: dict[tuple, RouteResult] = {}


def client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=25.0, headers={"User-Agent": USER_AGENT}, follow_redirects=True)
    return _client


async def close() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


async def route(
    a: geo.LatLon,
    b: geo.LatLon,
    mode: str,
    provider: str = "osrm",
    google_key: Optional[str] = None,
    road_data: bool = False,
) -> RouteResult:
    """Path from a to b. ``road_data`` also fetches public speed-limit data (slower)."""
    if mode not in MODES:
        raise RoutingError(f"Unknown travel mode {mode!r}")
    if mode == "straight" or geo.haversine_m(a, b) < 1.0:
        return RouteResult([a, b], "straight")
    if mode == "sea":
        key = ("sea", _r(a), _r(b))
        if key not in _cache:
            _cache[key] = RouteResult(await asyncio.to_thread(_sea_route, a, b), "searoute")
        return _cache[key]
    if provider == "google":
        if not google_key:
            raise RoutingError("Google routing needs an API key (Settings > Google Maps)")
        return await _google_route(a, b, mode, google_key)
    key = ("osrm", _r(a), _r(b), mode, road_data)
    if key in _cache:
        return _cache[key]
    res = await _osrm_route(a, b, mode, road_data)
    if len(_cache) > 300:
        _cache.clear()
    _cache[key] = res
    return res


def _r(p: geo.LatLon) -> tuple[float, float]:
    return (round(p[0], 6), round(p[1], 6))


def _with_connectors(
    a: geo.LatLon, b: geo.LatLon, pts: list[geo.LatLon], seg_speeds: list[Optional[float]], mode: str
) -> tuple[list[geo.LatLon], list[tuple[float, Optional[float]]], dict]:
    """Join the real waypoints to the snapped road path; the joins become their own zones.

    A long join usually means the waypoint is on a road the router may not use: a private road,
    a gated community, a car park. For cars those joins get a low speed cap.
    """
    features = {"offnet_m": 0.0}
    full = [a, *pts, b]
    speeds: list[Optional[float]] = []
    d0 = geo.haversine_m(a, pts[0])
    d1 = geo.haversine_m(pts[-1], b)
    off_cap = road_speed.OFFNET_CAP_KMH / 3.6 if mode == "car" else None
    speeds.append(off_cap if d0 >= OFFNET_MIN_M else (seg_speeds[0] if seg_speeds else None))
    speeds.extend(seg_speeds)
    speeds.append(off_cap if d1 >= OFFNET_MIN_M else (seg_speeds[-1] if seg_speeds else None))
    for d in (d0, d1):
        if d >= OFFNET_MIN_M:
            features["offnet_m"] += d
    zones: list[tuple[float, Optional[float]]] = []
    s = 0.0
    for (p, q), v in zip(zip(full, full[1:]), speeds):
        s += geo.haversine_m(p, q)
        zones.append((s, v))
    return full, zones, features


async def _osrm_route(a: geo.LatLon, b: geo.LatLon, mode: str, road_data: bool) -> RouteResult:
    base = OSRM_URLS[mode].rstrip("/")
    url = f"{base}/route/v1/driving/{a[1]:.6f},{a[0]:.6f};{b[1]:.6f},{b[0]:.6f}"
    params = {"overview": "full", "geometries": "geojson", "steps": "true", "annotations": "speed,nodes"}
    try:
        r = await client().get(url, params=params)
    except httpx.HTTPError as e:
        raise RoutingError(
            f"Could not reach the {mode} routing server ({e.__class__.__name__}). "
            "Check your internet connection, switch to Google routing, or use 'straight'."
        ) from e
    if r.status_code == 429:
        raise RoutingError("The routing server is rate-limiting requests. Wait a moment and try again.")
    try:
        data = r.json()
    except ValueError as e:
        raise RoutingError(f"Routing server returned HTTP {r.status_code}") from e
    if data.get("code") != "Ok" or not data.get("routes"):
        raise RoutingError(f"No {mode} route found: {data.get('message') or data.get('code')}")
    rt = data["routes"][0]
    coords = rt["geometry"]["coordinates"]
    pts = [(lat, lon) for lon, lat in coords]
    speeds: list[Optional[float]] = []
    nodes: list[int] = []
    uturns = 0
    for leg in rt.get("legs", []):
        ann = leg.get("annotation") or {}
        speeds.extend(float(v) if v and v > 0 else None for v in ann.get("speed", []))
        nodes.extend(ann.get("nodes", []))
        for st in leg.get("steps", []):
            if (st.get("maneuver") or {}).get("modifier") == "uturn":
                uturns += 1
    if len(speeds) != len(pts) - 1:  # defensive: annotation must match the geometry
        speeds = [None] * (len(pts) - 1)
    notes: list[str] = []
    features: dict = {"uturns": uturns}
    if road_data and mode == "car" and nodes:
        try:
            info = await road_speed.fetch_osm_roads(client(), nodes)
            if len(info.maxspeed_kmh) == len(speeds):
                speeds = _apply_osm(speeds, info, features)
                notes.append(f"Speed limits known for {info.coverage:.0%} of this leg ({info.source}).")
            elif info.source:
                notes.append(f"Speed-limit data {info.source}.")
        except (httpx.HTTPError, ValueError) as e:
            log.info("overpass failed: %r", e)
            notes.append("Public speed-limit data (OpenStreetMap Overpass) was unavailable; used typical road speeds.")
    full, zones, f2 = _with_connectors(a, b, pts, speeds, mode)
    features.update(f2)
    return RouteResult(full, "osrm", zones, float(rt.get("duration") or 0) or None, features, notes)


def _apply_osm(speeds: list[Optional[float]], info: road_speed.RoadInfo, features: dict) -> list[Optional[float]]:
    out: list[Optional[float]] = []
    hw = rs = 0
    for v, lim, kind in zip(speeds, info.maxspeed_kmh, info.kind):
        if kind == "restricted":
            rs += 1
            cap = road_speed.RESTRICTED_CAP_KMH / 3.6
            v = min(v, cap) if v else cap
        if kind == "highway":
            hw += 1
        if lim is not None:
            lim_ms = lim / 3.6
            # Typical traffic flows a little under the limit; never plan above it.
            v = min(v, lim_ms) if v else lim_ms * 0.9
        out.append(v)
    features["highway_segments"] = hw
    features["restricted_segments"] = rs
    return out


async def _google_route(a: geo.LatLon, b: geo.LatLon, mode: str, key: str) -> RouteResult:
    try:
        g = await google_api.compute_route(client(), key, a, b, mode)
    except google_api.GoogleError as e:
        raise RoutingError(str(e)) from e
    # step speeds -> zones along the decoded polyline (scaled to its geometric length)
    geo_len = geo.polyline_length(g.points)
    scale = geo_len / g.distance_m if g.distance_m > 0 else 1.0
    step_zones = [(st["end_m"] * scale, st["speed_ms"]) for st in g.steps]
    uturns = sum(1 for st in g.steps if "UTURN" in (st.get("maneuver") or ""))
    highway = sum(1 for st in g.steps if (st.get("maneuver") or "").startswith(("RAMP", "MERGE")))
    # Convert step zones into per-segment speeds of the polyline
    seg_speeds: list[Optional[float]] = []
    s = 0.0
    zi = 0
    for p, q in zip(g.points, g.points[1:]):
        mid = s + geo.haversine_m(p, q) / 2
        while zi < len(step_zones) - 1 and step_zones[zi][0] < mid:
            zi += 1
        seg_speeds.append(step_zones[zi][1] if step_zones else None)
        s += geo.haversine_m(p, q)
    full, zones, features = _with_connectors(a, b, g.points, seg_speeds, mode)
    features.update({"uturns": uturns, "ramps": highway})
    notes = list(g.warnings)
    ref = g.duration_s or g.static_duration_s or None
    return RouteResult(full, "google", zones, ref, features, notes, exportable=False)


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
    pts = [(lat, ((lon + 180.0) % 360.0) - 180.0) for lon, lat in coords]
    return [a, *pts, b]


async def geocode(query: str, limit: int = 6) -> list[dict]:
    """Place search (OpenStreetMap Nominatim). Their policy: max 1 request/second, so the UI only
    searches when the user presses Enter."""
    q = query.strip()
    if not q:
        return []
    try:
        r = await client().get(f"{NOMINATIM_URL}/search", params={"q": q, "format": "jsonv2", "limit": limit})
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
