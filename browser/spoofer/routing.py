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
import bisect
import logging
import os
import time
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Awaitable, Callable, Optional

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

# The public FOSSGIS servers allow at most one request per second
# (https://routing.openstreetmap.de/about.html). Your own OSRM server (SPOOFER_OSRM_*) is not throttled.
OSRM_PUBLIC_HOST = "routing.openstreetmap.de"
OSRM_MIN_INTERVAL_S = 1.0

# Alternative routes. OSRM returns at most one alternative in practice, so extra ones are found by
# routing through a "via" point beside the main route and keeping only detours that are sensible.
MAX_ALTERNATIVES = 3
# Via points tried for detours, most promising first: (share of the way along the main route,
# sideways offset as a share of the leg length; positive = right of the direction of travel there).
VIA_GRID = (
    (0.5, 0.15), (0.5, -0.15), (0.35, 0.22), (0.35, -0.22), (0.65, 0.22), (0.65, -0.22),
    (0.5, 0.3), (0.5, -0.3), (0.25, 0.15), (0.25, -0.15), (0.75, 0.15), (0.75, -0.15),
)
MAX_VIA_REQUESTS = 12  # extra routing requests per route build, on top of one per leg
VIA_PER_MISSING = 4  # a leg tries at most this many via points per alternative it still lacks
MIN_ALT_LEG_M = 400.0  # shorter legs don't get detour alternatives
ALT_MAX_DURATION_RATIO = 1.5  # a detour may take at most 50 % longer than the main route
ALT_MAX_DISTANCE_RATIO = 1.6
ALT_MAX_OVERLAP = 0.8  # share of road segments a detour may share with an already chosen route
# When too few detours pass, near misses (a little slower, longer or more similar) fill the gap.
# Detours that turn back, loop or drive a road twice are never offered.
ALT_RELAXED_DURATION_RATIO = 1.8
ALT_RELAXED_DISTANCE_RATIO = 1.9
ALT_RELAXED_OVERLAP = 0.9
VIA_MAX_TURN_DEG = 150.0  # a sharper turn at the via point is a U-turn "spike": rejected
# A detour may not turn back on itself more often than the main route does: a heading reversal of
# more than REVERSAL_MIN_DEG over REVERSAL_WINDOW x REVERSAL_STEP_M either side of a point (up one
# street and back down the next, or a lap round a block) is not a real alternative.
REVERSAL_STEP_M = 50.0
REVERSAL_WINDOW = 6
REVERSAL_MIN_DEG = 135.0

Report = Optional[Callable[[str], Awaitable[None]]]


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
    kind: str = "main"  # main | alternative (offered by the provider) | detour (found through a via point)
    # (start m, end m) along `points` of every roundabout the route drives on
    roundabouts: list[tuple[float, float]] = field(default_factory=list)


@dataclass
class ViaBudget:
    """How many extra (via point) routing requests one route build may still make."""

    left: int = MAX_VIA_REQUESTS


_client: Optional[httpx.AsyncClient] = None
_cache: dict[tuple, list[RouteResult]] = {}


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
    return (await route_options(a, b, mode, provider, google_key, road_data))[0]


async def route_options(
    a: geo.LatLon,
    b: geo.LatLon,
    mode: str,
    provider: str = "osrm",
    google_key: Optional[str] = None,
    road_data: bool = False,
    count: int = 0,
    budget: Optional[ViaBudget] = None,
    report: Report = None,
    detours: bool = True,
) -> list[RouteResult]:
    """The main path from a to b, then up to ``count`` alternative paths (fastest first).
    ``detours=False`` only keeps the alternatives the routing service offers itself (no extra
    requests). Sea and straight legs have no alternatives."""
    if mode not in MODES:
        raise RoutingError(f"Unknown travel mode {mode!r}")
    count = max(0, min(int(count), MAX_ALTERNATIVES))
    if mode == "straight" or geo.haversine_m(a, b) < 1.0:
        return [RouteResult([a, b], "straight")]
    if mode == "sea":
        key = ("sea", _r(a), _r(b))
        if key not in _cache:
            _cache[key] = [RouteResult(await asyncio.to_thread(_sea_route, a, b), "searoute")]
        return _cache[key]
    if provider == "google":
        if not google_key:
            raise RoutingError("Google routing needs an API key (Settings > Google Maps)")
        return await _google_routes(a, b, mode, google_key, count)
    key = ("osrm", _r(a), _r(b), mode, road_data, count, detours)
    if key in _cache:
        return _cache[key]
    use_budget = (budget or ViaBudget(0)) if detours else ViaBudget(0)
    res, complete = await _osrm_options(a, b, mode, road_data, count, use_budget, report)
    if len(_cache) > 300:
        _cache.clear()
    if complete:  # a search cut short by the request budget may find more next time
        _cache[key] = res
    return res


def _osrm_reserve(base_url: str) -> float:
    """Seconds to wait before the next request to the public OSRM server (one per second)."""
    global _osrm_next
    if OSRM_MIN_INTERVAL_S <= 0 or OSRM_PUBLIC_HOST not in base_url:
        return 0.0
    now = time.monotonic()
    start = max(now, _osrm_next)
    _osrm_next = start + OSRM_MIN_INTERVAL_S
    return start - now


_osrm_next = 0.0


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


UNKNOWN_NODE = -1  # an OSM node id OSRM could not report exactly
ROUNDABOUT_STEPS = ("roundabout", "rotary")  # OSRM step types for driving round a roundabout
MINI_ROUNDABOUT_M = 12.0  # a mini roundabout ("roundabout turn") counts this far either side of its point


def roundabout_ranges(points: list[geo.LatLon], rings: list[tuple[geo.LatLon, geo.LatLon]]) -> list[tuple[float, float]]:
    """(start m, end m) along `points` for each roundabout given by its entry and exit point."""
    if not rings or len(points) < 2:
        return []
    cum = geo.cumulative(points)
    out: list[tuple[float, float]] = []
    k = 0  # roundabouts come in route order: search onwards from the last one
    for entry, exit_ in rings:
        i = min(range(k, len(points)), key=lambda j: geo.haversine_m(points[j], entry))
        if entry == exit_:
            s0, s1 = max(0.0, cum[i] - MINI_ROUNDABOUT_M), min(cum[-1], cum[i] + MINI_ROUNDABOUT_M)
            j = i
        else:
            j = min(range(i, len(points)), key=lambda q: geo.haversine_m(points[q], exit_))
            s0, s1 = cum[i], cum[j]
        if s1 > s0:
            out.append((round(s0, 1), round(s1, 1)))
        k = j
    return out


@dataclass
class _Candidate:
    pts: list[geo.LatLon]  # OSRM geometry (snapped to the road network)
    speeds: list[Optional[float]]  # per geometry segment, m/s
    nodes: list[list[int]]  # OSM node ids per OSRM leg (a detour has two legs)
    uturns: int
    duration: float
    distance: float
    kind: str = "main"
    via_turn: float = 0.0  # turn angle at the via point, degrees (0 = straight on)
    # roundabouts as (entry point, exit point) from the OSRM maneuvers
    roundabouts: list[tuple[geo.LatLon, geo.LatLon]] = field(default_factory=list)

    def pairs(self) -> set[tuple[int, int]]:
        out: set[tuple[int, int]] = set()
        for ns in self.nodes:
            for x, y in zip(ns, ns[1:]):
                if x > 0 and y > 0:
                    out.add((x, y) if x < y else (y, x))
        return out

    def doubles_back(self) -> bool:
        """True when the path uses a road segment twice (a loop round a block or a spike to the
        via point and back). The segment the via point sits on may end one leg and start the next
        when the path carries straight on (same direction); driving it back counts."""
        def key(x: int, y: int) -> tuple[int, int]:
            return (x, y) if x < y else (y, x)

        seen: set[tuple[int, int]] = set()
        for k, ns in enumerate(self.nodes):
            prev = self.nodes[k - 1] if k > 0 else []
            for i, (x, y) in enumerate(zip(ns, ns[1:])):
                if x <= 0 or y <= 0:
                    continue
                pair = key(x, y)
                junction = i == 0 and len(prev) >= 2 and (x, y) == (prev[-2], prev[-1])
                if pair in seen and not junction:
                    return True
                seen.add(pair)
        return False


async def _osrm_fetch(coords: list[geo.LatLon], mode: str, alternatives: int = 0) -> dict:
    base = OSRM_URLS[mode].rstrip("/")
    path = ";".join(f"{lon:.6f},{lat:.6f}" for lat, lon in coords)
    url = f"{base}/route/v1/driving/{path}"
    params = {"overview": "full", "geometries": "geojson", "steps": "true", "annotations": "speed,nodes"}
    if alternatives:
        params["alternatives"] = str(alternatives)
    wait = _osrm_reserve(base)
    if wait > 0:
        await asyncio.sleep(wait)
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
        if alternatives and data.get("code") == "TooBig":
            # a self-hosted server may allow fewer alternatives: ask for the main route only
            return await _osrm_fetch(coords, mode, 0)
        raise RoutingError(f"No {mode} route found: {data.get('message') or data.get('code')}")
    return data


def _parse_osrm(rt: dict, kind: str) -> _Candidate:
    pts = [(lat, lon) for lon, lat in rt["geometry"]["coordinates"]]
    speeds: list[Optional[float]] = []
    nodes: list[list[int]] = []
    roundabouts: list[tuple[geo.LatLon, geo.LatLon]] = []
    uturns = 0
    legs = rt.get("legs", [])
    for leg in legs:
        ann = leg.get("annotation") or {}
        speeds.extend(float(v) if v and v > 0 else None for v in ann.get("speed", []))
        # OSRM writes node ids of 10 billion and up as rounded floats (1.134297535e+10), which no
        # longer name one node: keep their place in the list but mark them unknown.
        nodes.append([v if isinstance(v, int) and v > 0 else UNKNOWN_NODE for v in ann.get("nodes", [])])
        steps = leg.get("steps", [])
        for i, st in enumerate(steps):
            m = st.get("maneuver") or {}
            if m.get("modifier") == "uturn":
                uturns += 1
            loc = m.get("location")
            if not loc:
                continue
            if m.get("type") in ROUNDABOUT_STEPS:
                # the step covers the drive round the roundabout; the next maneuver is the exit
                nxt = ((steps[i + 1].get("maneuver") or {}).get("location") if i + 1 < len(steps) else None) or loc
                roundabouts.append(((loc[1], loc[0]), (nxt[1], nxt[0])))
            elif m.get("type") == "roundabout turn":  # a mini roundabout, driven like a junction
                roundabouts.append(((loc[1], loc[0]), (loc[1], loc[0])))
    if len(speeds) != len(pts) - 1:  # defensive: annotation must match the geometry
        speeds = [None] * (len(pts) - 1)
    via_turn = 0.0
    for l0, l1 in zip(legs, legs[1:]):
        before = ((l0.get("steps") or [{}])[-1].get("maneuver") or {}).get("bearing_before")
        after = ((l1.get("steps") or [{}])[0].get("maneuver") or {}).get("bearing_after")
        if before is not None and after is not None:
            via_turn = max(via_turn, abs((after - before + 540) % 360 - 180))
    return _Candidate(pts, speeds, nodes, uturns, float(rt.get("duration") or 0), float(rt.get("distance") or 0), kind, via_turn,
                      roundabouts)


def _resample(pts: list[geo.LatLon], step: float) -> list[geo.LatLon]:
    """Points every `step` metres along a polyline."""
    out = [pts[0]]
    carry = 0.0  # distance from the last sample to the start of the current segment
    for a, b in zip(pts, pts[1:]):
        d = geo.haversine_m(a, b)
        if d <= 0:
            continue
        t = step - carry
        while t <= d:
            out.append(geo.interpolate(a, b, t / d))
            t += step
        carry = d - (t - step)
    return out


def _reversals(pts: list[geo.LatLon]) -> int:
    """How many times the path turns back on itself (see REVERSAL_MIN_DEG)."""
    if len(pts) < 2:
        return 0
    r, w = _resample(pts, REVERSAL_STEP_M), REVERSAL_WINDOW
    events, inside = 0, False
    for i in range(w, len(r) - w):
        b1, b2 = geo.bearing_deg(r[i - w], r[i]), geo.bearing_deg(r[i], r[i + w])
        if abs((b2 - b1 + 540) % 360 - 180) > REVERSAL_MIN_DEG:
            events += not inside
            inside = True
        else:
            inside = False
    return events


def _point_at_fraction(pts: list[geo.LatLon], f: float) -> geo.LatLon:
    cum = geo.cumulative(pts)
    target = cum[-1] * f
    i = max(1, bisect.bisect_left(cum, target))
    if i >= len(pts):
        return pts[-1]
    seg = cum[i] - cum[i - 1]
    return geo.interpolate(pts[i - 1], pts[i], (target - cum[i - 1]) / seg if seg > 0 else 0.0)


def _heading_at_fraction(pts: list[geo.LatLon], f: float) -> float:
    """Direction of the path around a share f of the way along it."""
    return geo.bearing_deg(_point_at_fraction(pts, max(0.0, f - 0.05)), _point_at_fraction(pts, min(1.0, f + 0.05)))


def _overlap(pairs: set, taken: list[set]) -> float:
    """Largest share of a route's road segments that another route also uses."""
    return max((len(pairs & t) / len(pairs) for t in taken), default=0.0) if pairs else 0.0


def _judge_detour(c: _Candidate, main: _Candidate, main_reversals: int, taken: list[set]) -> str:
    """"ok" (offer it), "near" (offer it only when too few pass) or "no"."""
    if c.via_turn > VIA_MAX_TURN_DEG or c.uturns > main.uturns or c.doubles_back():
        return "no"  # it turns back at the via point or drives a road twice
    if _reversals(c.pts) > main_reversals:
        return "no"  # up one street and back down the next: not a real alternative
    dur = c.duration / main.duration if main.duration else 1.0
    dist = c.distance / main.distance if main.distance else 1.0
    ov = _overlap(c.pairs(), taken)
    if dur <= ALT_MAX_DURATION_RATIO and dist <= ALT_MAX_DISTANCE_RATIO and ov <= ALT_MAX_OVERLAP:
        return "ok"
    if dur <= ALT_RELAXED_DURATION_RATIO and dist <= ALT_RELAXED_DISTANCE_RATIO and ov <= ALT_RELAXED_OVERLAP:
        return "near"
    return "no"


def _take_near_misses(cands: list[_Candidate], near: list[_Candidate], count: int, taken: list[set]) -> None:
    for c in sorted(near, key=lambda x: x.duration):
        if len(cands) - 1 >= count:
            return
        pairs = c.pairs()
        if _overlap(pairs, taken) <= ALT_RELAXED_OVERLAP:  # still different enough from what was added since
            cands.append(c)
            taken.append(pairs)


async def _add_detours(
    a: geo.LatLon, b: geo.LatLon, mode: str, cands: list[_Candidate], count: int, budget: ViaBudget, report: Report
) -> bool:
    """Find detour alternatives through via points beside the main route (see VIA_GRID).
    Returns False when the request budget ran out before the search finished."""
    main = cands[0]
    length = geo.haversine_m(a, b)
    if length < MIN_ALT_LEG_M or len(main.pts) < 2:
        return True
    taken = [c.pairs() for c in cands]
    main_reversals = _reversals(main.pts)
    near: list[_Candidate] = []
    tries = min(len(VIA_GRID), VIA_PER_MISSING * (count - (len(cands) - 1)))
    complete = True
    for f, off in VIA_GRID[:tries]:
        if len(cands) - 1 >= count:
            break
        if budget.left <= 0:
            complete = False
            break
        budget.left -= 1
        if report:
            await report(f"Searching for alternative routes ({len(cands) - 1} of {count} found)")
        side = 90 if off > 0 else -90
        via = geo.destination(_point_at_fraction(main.pts, f), (_heading_at_fraction(main.pts, f) + side) % 360, abs(off) * length)
        try:
            data = await _osrm_fetch([a, via, b], mode)
        except RoutingError as e:
            log.info("detour search failed: %s", e)
            continue
        c = _parse_osrm(data["routes"][0], "detour")
        verdict = _judge_detour(c, main, main_reversals, taken)
        if verdict == "ok":
            cands.append(c)
            taken.append(c.pairs())
        elif verdict == "near":
            near.append(c)
    _take_near_misses(cands, near, count, taken)
    return complete or len(cands) - 1 >= count


async def _osrm_options(
    a: geo.LatLon, b: geo.LatLon, mode: str, road_data: bool, count: int, budget: ViaBudget, report: Report
) -> tuple[list[RouteResult], bool]:
    data = await _osrm_fetch([a, b], mode, count)
    cands = [_parse_osrm(rt, "main" if i == 0 else "alternative") for i, rt in enumerate(data["routes"][: 1 + count])]
    complete = True
    if len(cands) - 1 < count:
        complete = await _add_detours(a, b, mode, cands, count, budget, report)
    if len(cands) > 2:  # keep the main route first, alternatives fastest first
        cands[1:] = sorted(cands[1:], key=lambda c: c.duration)
    infos: list[Optional[road_speed.RoadInfo]] = [None] * len(cands)
    overpass_failed = False
    if road_data and mode == "car" and any(any(n) for c in cands for n in c.nodes):
        if report:
            await report("Analysing speed-limit data (OpenStreetMap)")
        try:
            flat = [n for c in cands for n in c.nodes]
            got = await road_speed.fetch_osm_roads_multi(client(), flat)
            k = 0
            for i, c in enumerate(cands):
                infos[i] = road_speed.concat(got[k:k + len(c.nodes)])
                k += len(c.nodes)
        except (httpx.HTTPError, ValueError) as e:
            log.info("overpass failed: %r", e)
            overpass_failed = True
    results = []
    for c, info in zip(cands, infos):
        notes: list[str] = []
        features: dict = {"uturns": c.uturns}
        speeds = c.speeds
        if road_data and mode == "car" and any(c.nodes):
            if overpass_failed:
                notes.append("Public speed-limit data (OpenStreetMap Overpass) was unavailable; used typical road speeds.")
            elif info is not None and len(info.maxspeed_kmh) == len(speeds):
                speeds = _apply_osm(speeds, info, features)
                notes.append(f"Speed limits known for {info.coverage:.0%} of this leg ({info.source}).")
            elif info is not None and info.source:
                notes.append(f"Speed-limit data {info.source}.")
        full, zones, f2 = _with_connectors(a, b, c.pts, speeds, mode)
        features.update(f2)
        rings = roundabout_ranges(full, c.roundabouts)
        if rings:
            features["roundabouts"] = len(rings)
        results.append(RouteResult(full, "osrm", zones, c.duration or None, features, notes, kind=c.kind, roundabouts=rings))
    return results, complete


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


async def _google_routes(a: geo.LatLon, b: geo.LatLon, mode: str, key: str, count: int = 0) -> list[RouteResult]:
    try:
        found = await google_api.compute_routes(client(), key, a, b, mode, alternatives=count > 0)
    except google_api.GoogleError as e:
        raise RoutingError(str(e)) from e
    out = [_google_result(a, b, mode, g) for g in found[: 1 + count]]
    for r in out[1:]:
        r.kind = "alternative"
    return out


def _google_result(a: geo.LatLon, b: geo.LatLon, mode: str, g: google_api.GoogleRoute) -> RouteResult:
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
    # Google's roundabout steps run from the entry to the exit; shift by the join from the waypoint
    off = geo.haversine_m(a, g.points[0]) if g.points else 0.0
    rings = [(round(off + st["start_m"] * scale, 1), round(off + st["end_m"] * scale, 1))
             for st in g.steps if (st.get("maneuver") or "").startswith("ROUNDABOUT") and st["end_m"] > st["start_m"]]
    if rings:
        features["roundabouts"] = len(rings)
    notes = list(g.warnings)
    ref = g.duration_s or g.static_duration_s or None
    return RouteResult(full, "google", zones, ref, features, notes, exportable=False, roundabouts=rings)


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
