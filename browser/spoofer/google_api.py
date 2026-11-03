"""Google Maps Platform calls (optional; needs the user's own API key).

* Routes API ``computeRoutes`` for routing (roads, cycling, walking).
* Map Tiles API 2D tiles, so routes from Google are shown on a Google map. Google's Routes API
  policies require "Routes API results displayed on a map must be shown on a Google Map".
  Third-party renderers (Leaflet here) are allowed for Map Tiles with Google attribution.

Route results are not cached or exported (Google restricts caching of Routes API content).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

import httpx

from . import geo

ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes"
TILES_SESSION_URL = "https://tile.googleapis.com/v1/createSession"
TILES_VIEWPORT_URL = "https://tile.googleapis.com/tile/v1/viewport"
FIELD_MASK = ",".join(
    [
        "routes.duration",
        "routes.staticDuration",
        "routes.distanceMeters",
        "routes.polyline.encodedPolyline",
        "routes.legs.steps.distanceMeters",
        "routes.legs.steps.staticDuration",
        "routes.legs.steps.polyline.encodedPolyline",
        "routes.legs.steps.navigationInstruction.maneuver",
        "routes.warnings",
        "routes.routeLabels",
    ]
)
TRAVEL_MODES = {"car": "DRIVE", "bike": "BICYCLE", "foot": "WALK"}


class GoogleError(Exception):
    pass


@dataclass
class GoogleRoute:
    points: list[geo.LatLon]
    duration_s: float  # with traffic when traffic-aware
    static_duration_s: float
    distance_m: float
    steps: list[dict] = field(default_factory=list)  # {start_m, end_m, speed_ms, maneuver}
    warnings: list[str] = field(default_factory=list)


def decode_polyline(encoded: str, precision: int = 5) -> list[geo.LatLon]:
    """Google's Encoded Polyline Algorithm."""
    coords: list[geo.LatLon] = []
    index = lat = lng = 0
    factor = 10**precision
    n = len(encoded)
    while index < n:
        for which in (0, 1):
            shift = result = 0
            while True:
                if index >= n:
                    raise GoogleError("Malformed polyline from Google")
                b = ord(encoded[index]) - 63
                index += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            delta = ~(result >> 1) if result & 1 else result >> 1
            if which == 0:
                lat += delta
            else:
                lng += delta
        coords.append((lat / factor, lng / factor))
    return coords


def _seconds(text: Optional[str]) -> float:
    m = re.fullmatch(r"([\d.]+)s", text or "")
    return float(m.group(1)) if m else 0.0


def _error_message(r: httpx.Response) -> str:
    try:
        err = r.json().get("error", {})
        msg = err.get("message") or r.text[:200]
        status = err.get("status", "")
    except ValueError:
        msg, status = r.text[:200], ""
    if r.status_code in (401, 403) or status == "PERMISSION_DENIED":
        return f"Google refused the API key: {msg} (enable 'Routes API' and 'Map Tiles API' for the key)"
    return f"Google Routes API error {r.status_code}: {msg}"


async def compute_route(
    client: httpx.AsyncClient, key: str, a: geo.LatLon, b: geo.LatLon, mode: str, traffic: bool = True
) -> GoogleRoute:
    return (await compute_routes(client, key, a, b, mode, traffic))[0]


async def compute_routes(
    client: httpx.AsyncClient,
    key: str,
    a: geo.LatLon,
    b: geo.LatLon,
    mode: str,
    traffic: bool = True,
    alternatives: bool = False,
) -> list[GoogleRoute]:
    """The default route, then (with ``alternatives``) up to three alternatives Google offers.
    Alternatives arrive in the same response, so no extra requests are made."""
    travel = TRAVEL_MODES.get(mode)
    if travel is None:
        raise GoogleError(f"Google routing does not support the '{mode}' mode")
    body: dict = {
        "origin": {"location": {"latLng": {"latitude": a[0], "longitude": a[1]}}},
        "destination": {"location": {"latLng": {"latitude": b[0], "longitude": b[1]}}},
        "travelMode": travel,
        "polylineQuality": "HIGH_QUALITY",
        "polylineEncoding": "ENCODED_POLYLINE",
    }
    if travel == "DRIVE":
        body["routingPreference"] = "TRAFFIC_AWARE" if traffic else "TRAFFIC_UNAWARE"
    if alternatives:
        body["computeAlternativeRoutes"] = True
    try:
        r = await client.post(
            ROUTES_URL,
            json=body,
            headers={"X-Goog-Api-Key": key, "X-Goog-FieldMask": FIELD_MASK, "Content-Type": "application/json"},
        )
    except httpx.HTTPError as e:
        raise GoogleError(f"Could not reach Google ({e.__class__.__name__})") from e
    if r.status_code != 200:
        raise GoogleError(_error_message(r))
    data = r.json()
    routes = data.get("routes") or []
    if not routes:
        raise GoogleError(f"Google found no {mode} route between these points")
    out = [_parse_route(route) for route in routes]
    if len(out[0].points) < 2:
        raise GoogleError("Google returned an empty route")
    return [out[0], *(g for g in out[1:] if len(g.points) >= 2)]


def _parse_route(route: dict) -> GoogleRoute:
    pts = decode_polyline(route.get("polyline", {}).get("encodedPolyline", ""))
    steps: list[dict] = []
    s = 0.0
    for leg in route.get("legs", []):
        for st in leg.get("steps", []):
            d = float(st.get("distanceMeters") or 0)
            t = _seconds(st.get("staticDuration"))
            steps.append(
                {
                    "start_m": s,
                    "end_m": s + d,
                    "speed_ms": d / t if t > 0 and d > 0 else None,
                    "maneuver": (st.get("navigationInstruction") or {}).get("maneuver", ""),
                }
            )
            s += d
    return GoogleRoute(
        points=pts,
        duration_s=_seconds(route.get("duration")),
        static_duration_s=_seconds(route.get("staticDuration")),
        distance_m=float(route.get("distanceMeters") or (geo.polyline_length(pts) if pts else 0.0)),
        steps=steps,
        warnings=list(route.get("warnings") or []),
    )


async def create_tile_session(client: httpx.AsyncClient, key: str, map_type: str = "roadmap",
                              language: str = "en-US", region: str = "US") -> dict:
    body = {"mapType": map_type, "language": language, "region": region}
    if map_type == "satellite":
        body = {"mapType": "satellite", "language": language, "region": region}
    try:
        r = await client.post(f"{TILES_SESSION_URL}?key={key}", json=body)
    except httpx.HTTPError as e:
        raise GoogleError(f"Could not reach Google ({e.__class__.__name__})") from e
    if r.status_code != 200:
        raise GoogleError(_error_message(r).replace("Routes API error", "Map Tiles API error"))
    return r.json()


async def viewport_copyright(client: httpx.AsyncClient, key: str, session: str, zoom: int,
                             north: float, south: float, east: float, west: float) -> str:
    params = {"session": session, "key": key, "zoom": zoom, "north": north, "south": south, "east": east, "west": west}
    try:
        r = await client.get(TILES_VIEWPORT_URL, params=params)
        r.raise_for_status()
        return r.json().get("copyright", "")
    except (httpx.HTTPError, ValueError):
        return ""
