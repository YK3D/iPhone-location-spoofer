"""Small spherical-geometry helpers (WGS84 approximated by a sphere)."""

from __future__ import annotations

import math
import random
from typing import Iterable, Sequence

EARTH_RADIUS_M = 6_371_008.8

LatLon = tuple[float, float]


def haversine_m(a: LatLon, b: LatLon) -> float:
    """Great-circle distance in metres between two (lat, lon) points."""
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(h)))


def bearing_deg(a: LatLon, b: LatLon) -> float:
    """Initial bearing from a to b, degrees clockwise from north, in [0, 360)."""
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    dlon = lon2 - lon1
    x = math.sin(dlon) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return (math.degrees(math.atan2(x, y)) + 360.0) % 360.0


def interpolate(a: LatLon, b: LatLon, f: float) -> LatLon:
    """Point at fraction f along the great circle from a to b."""
    if f <= 0:
        return a
    if f >= 1:
        return b
    d = haversine_m(a, b) / EARTH_RADIUS_M
    if d < 1e-9:
        return a
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    sa = math.sin((1 - f) * d) / math.sin(d)
    sb = math.sin(f * d) / math.sin(d)
    x = sa * math.cos(lat1) * math.cos(lon1) + sb * math.cos(lat2) * math.cos(lon2)
    y = sa * math.cos(lat1) * math.sin(lon1) + sb * math.cos(lat2) * math.sin(lon2)
    z = sa * math.sin(lat1) + sb * math.sin(lat2)
    lat = math.atan2(z, math.hypot(x, y))
    lon = math.atan2(y, x)
    return (math.degrees(lat), _wrap_lon(math.degrees(lon)))


def destination(a: LatLon, bearing: float, distance_m: float) -> LatLon:
    """Point reached travelling distance_m from a on the given initial bearing."""
    lat1, lon1 = map(math.radians, a)
    brg = math.radians(bearing)
    d = distance_m / EARTH_RADIUS_M
    lat2 = math.asin(math.sin(lat1) * math.cos(d) + math.cos(lat1) * math.sin(d) * math.cos(brg))
    lon2 = lon1 + math.atan2(
        math.sin(brg) * math.sin(d) * math.cos(lat1), math.cos(d) - math.sin(lat1) * math.sin(lat2)
    )
    return (math.degrees(lat2), _wrap_lon(math.degrees(lon2)))


def jitter(p: LatLon, radius_m: float, rng: random.Random | None = None) -> LatLon:
    """Random point with a Gaussian offset (sigma = radius_m / 2) around p."""
    if radius_m <= 0:
        return p
    r = rng or random
    dist = abs(r.gauss(0, radius_m / 2))
    return destination(p, r.uniform(0, 360), min(dist, radius_m * 2))


def _wrap_lon(lon: float) -> float:
    return ((lon + 180.0) % 360.0) - 180.0


def densify(points: Sequence[LatLon], max_step_m: float) -> list[LatLon]:
    """Insert great-circle points so no step is longer than max_step_m."""
    if not points:
        return []
    out = [points[0]]
    for a, b in zip(points, points[1:]):
        d = haversine_m(a, b)
        n = max(1, math.ceil(d / max_step_m))
        for i in range(1, n + 1):
            out.append(interpolate(a, b, i / n))
    return out


def cumulative(points: Sequence[LatLon]) -> list[float]:
    """Cumulative distance (m) at each vertex of a polyline."""
    out = [0.0]
    for a, b in zip(points, points[1:]):
        out.append(out[-1] + haversine_m(a, b))
    return out


def polyline_length(points: Iterable[LatLon]) -> float:
    pts = list(points)
    return cumulative(pts)[-1] if pts else 0.0


def validate_latlon(lat: float, lon: float) -> None:
    if not (math.isfinite(lat) and math.isfinite(lon)):
        raise ValueError("Coordinates must be finite numbers")
    if not -90.0 <= lat <= 90.0:
        raise ValueError(f"Latitude {lat} is outside -90..90")
    if not -180.0 <= lon <= 180.0:
        raise ValueError(f"Longitude {lon} is outside -180..180")


def parse_coordinates(text: str) -> LatLon:
    """Parse '19.0761, 72.8775', '19.0761 72.8775' or DMS like 40°42'46"N 74°00'21"W."""
    import re

    s = text.strip()
    dms = re.findall(
        r"(\d+(?:\.\d+)?)\s*°\s*(?:(\d+(?:\.\d+)?)\s*['′]\s*)?(?:(\d+(?:\.\d+)?)\s*[\"″]\s*)?([NSEW])",
        s,
        flags=re.IGNORECASE,
    )
    if len(dms) == 2:
        vals = []
        for deg, mins, secs, hemi in dms:
            v = float(deg) + float(mins or 0) / 60 + float(secs or 0) / 3600
            if hemi.upper() in "SW":
                v = -v
            vals.append((hemi.upper(), v))
        lat = next((v for h, v in vals if h in "NS"), None)
        lon = next((v for h, v in vals if h in "EW"), None)
        if lat is None or lon is None:
            raise ValueError("DMS coordinates need one N/S and one E/W value")
    else:
        nums = re.findall(r"[-+−]?\d+(?:\.\d+)?", s)
        if len(nums) != 2:
            raise ValueError("Enter two numbers: latitude and longitude")
        lat, lon = (float(n.replace("−", "-")) for n in nums)
    validate_latlon(lat, lon)
    return (lat, lon)
