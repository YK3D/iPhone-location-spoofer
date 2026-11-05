"""Experimental road-aware speeds: public speed-limit data and road features.

Sources, in order of trust:
1. OpenStreetMap tags of the roads under the route, via the Overpass API (``maxspeed``,
   ``highway`` class, ``access``/``service`` for private and gated roads). Optional: the public
   Overpass servers are often busy, so any failure just leaves this data out.
2. The routing service's own per-segment speeds (OSRM annotations, Google step durations).
   These already reflect road type and, where mapped, speed limits.
3. Geometry: sharp turns and U-turns are slowed in the profile engine (see profile.py).
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field
from typing import Optional

import httpx

log = logging.getLogger(__name__)

OVERPASS_URL = os.environ.get("SPOOFER_OVERPASS", "https://overpass-api.de/api/interpreter")
MAX_NODES_PER_QUERY = 1500
MAX_NODES_TOTAL = 6000
MPH = 1.609344

# Approximate defaults for implicit limits such as "DE:urban" (km/h). Only used when a road
# is tagged with a zone code instead of a number.
ZONE_DEFAULTS = {"urban": 50, "rural": 90, "motorway": 130, "trunk": 100, "living_street": 7,
                 "zone30": 30, "zone20": 20, "bicycle_road": 30, "school": 30, "walk": 7}
HIGHWAY_CLASSES = {"motorway", "motorway_link", "trunk", "trunk_link"}
RESTRICTED_ACCESS = {"private", "destination", "customers", "delivery", "permit", "no"}
RESTRICTED_SERVICE = {"driveway", "parking_aisle", "drive-through", "alley"}
RESTRICTED_CAP_KMH = 20.0
OFFNET_CAP_KMH = 15.0


@dataclass
class RoadInfo:
    """Per-segment information along one leg's geometry (segment i joins point i and i+1)."""

    maxspeed_kmh: list[Optional[float]] = field(default_factory=list)
    kind: list[str] = field(default_factory=list)  # "highway" | "restricted" | "road" | ""
    coverage: float = 0.0  # share of segments with a known speed limit
    source: str = ""


def parse_maxspeed(value: Optional[str]) -> Optional[float]:
    """OSM maxspeed tag -> km/h, or None when unknown/unlimited."""
    if not value:
        return None
    v = value.strip().lower()
    best: Optional[float] = None
    for part in re.split(r"[;|]", v):
        part = part.strip()
        m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*(mph|km/h|kmh|kph|knots)?", part)
        speed: Optional[float] = None
        if m:
            speed = float(m.group(1))
            if m.group(2) == "mph":
                speed *= MPH
            elif m.group(2) == "knots":
                speed *= 1.852
        elif part in ("walk",):
            speed = ZONE_DEFAULTS["walk"]
        elif ":" in part:
            zone = part.split(":", 1)[1]
            speed = ZONE_DEFAULTS.get(zone)
        if speed is not None and speed > 0:
            best = speed if best is None else min(best, speed)
    return best


def classify(tags: dict) -> str:
    hw = tags.get("highway", "")
    if hw in HIGHWAY_CLASSES:
        return "highway"
    access = tags.get("motor_vehicle") or tags.get("motorcar") or tags.get("vehicle") or tags.get("access") or ""
    if access in RESTRICTED_ACCESS or tags.get("service") in RESTRICTED_SERVICE or hw in ("service", "track"):
        return "restricted"
    return "road" if hw else ""


async def fetch_osm_roads(client: httpx.AsyncClient, nodes: list[int]) -> RoadInfo:
    """Speed limits and road classes for consecutive OSM node pairs (from OSRM annotations)."""
    return (await fetch_osm_roads_multi(client, [nodes]))[0]


async def fetch_osm_roads_multi(client: httpx.AsyncClient, node_lists: list[list[int]]) -> list[RoadInfo]:
    """fetch_osm_roads for several node sequences (route alternatives) with one set of queries:
    nodes shared between the sequences are only looked up once."""
    infos = [RoadInfo(maxspeed_kmh=[None] * max(0, len(n) - 1), kind=[""] * max(0, len(n) - 1)) for n in node_lists]
    # ids <= 0 are placeholders for nodes the router could not report exactly
    unique = list(dict.fromkeys(x for nodes in node_lists for x in nodes if isinstance(x, int) and x > 0))
    if len(unique) < 2:
        return infos
    if len(unique) > MAX_NODES_TOTAL:
        for info in infos:
            info.source = "skipped (route too long for the public speed-limit service)"
        return infos
    pair_tags: dict[tuple[int, int], dict] = {}
    for i in range(0, len(unique), MAX_NODES_PER_QUERY):
        chunk = unique[i:i + MAX_NODES_PER_QUERY]
        q = f"[out:json][timeout:25];node(id:{','.join(map(str, chunk))});way(bn)[highway];out body qt;"
        r = await client.post(OVERPASS_URL, data={"data": q}, timeout=30)
        r.raise_for_status()
        for el in r.json().get("elements", []):
            if el.get("type") != "way":
                continue
            nds, tags = el.get("nodes", []), el.get("tags", {})
            for x, y in zip(nds, nds[1:]):
                pair_tags[(x, y)] = tags
                pair_tags[(y, x)] = tags
    for nodes, info in zip(node_lists, infos):
        known = 0
        for i, (x, y) in enumerate(zip(nodes, nodes[1:])):
            tags = pair_tags.get((x, y))
            if not tags:
                continue
            info.kind[i] = classify(tags)
            ms = parse_maxspeed(tags.get("maxspeed"))
            info.maxspeed_kmh[i] = ms
            if ms is not None:
                known += 1
        info.coverage = known / max(1, len(nodes) - 1)
        info.source = "OpenStreetMap (Overpass)"
    return infos


def concat(infos: list[RoadInfo]) -> RoadInfo:
    """Join the per-leg RoadInfo of one multi-leg OSRM route (a via-point detour) into one."""
    out = RoadInfo()
    known = total = 0
    for info in infos:
        out.maxspeed_kmh.extend(info.maxspeed_kmh)
        out.kind.extend(info.kind)
        known += sum(1 for v in info.maxspeed_kmh if v is not None)
        total += len(info.maxspeed_kmh)
        out.source = out.source or info.source
    out.coverage = known / max(1, total)
    return out
