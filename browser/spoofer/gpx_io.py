"""Read and write GPX 1.0 / 1.1 files."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Optional, Sequence
from xml.sax.saxutils import escape

from defusedxml import ElementTree as DefusedET

from .profile import TimelinePoint

_TIME = re.compile(
    r"^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{1,2}):(\d{1,2})(?:\.(\d{1,15}))?(Z|[+\-]\d{2}:?(?:\d{2})?)?$"
)


@dataclass
class GpxPoint:
    lat: float
    lon: float
    time: Optional[datetime] = None
    name: Optional[str] = None


@dataclass
class GpxTrack:
    name: str
    kind: str  # "track" | "route" | "waypoints"
    points: list[GpxPoint] = field(default_factory=list)

    @property
    def timed(self) -> bool:
        return len(self.points) > 1 and all(p.time is not None for p in self.points)


def parse_time(text: Optional[str]) -> Optional[datetime]:
    m = _TIME.match(text.strip()) if text else None
    if not m:
        return None
    y, mo, d, h, mi, s = (int(m.group(i)) for i in range(1, 7))
    us = int((m.group(7) or "0")[:6].ljust(6, "0"))
    zone = m.group(8)
    tz = timezone.utc
    if zone and zone != "Z":
        digits = zone[1:].replace(":", "")
        off = timedelta(hours=int(digits[:2]), minutes=int(digits[2:] or 0))
        tz = timezone(off if zone[0] == "+" else -off)
    try:
        return datetime(y, mo, d, h, mi, s, us, tz)
    except ValueError:
        return None


def _local(tag: str) -> str:
    return tag.rpartition("}")[2]


def _child_text(el, name: str) -> Optional[str]:
    for c in el:
        if _local(c.tag) == name:
            return c.text
    return None


def _point(el) -> GpxPoint:
    try:
        lat, lon = float(el.attrib["lat"]), float(el.attrib["lon"])
    except (KeyError, ValueError) as e:
        raise ValueError(f"GPX point without a valid lat/lon: {dict(el.attrib)}") from e
    return GpxPoint(lat, lon, parse_time(_child_text(el, "time")), _child_text(el, "name"))


def parse_gpx(data: bytes | str) -> list[GpxTrack]:
    """All tracks (segments joined), routes and the waypoint set found in a GPX document."""
    try:
        root = DefusedET.fromstring(data)
    except DefusedET.ParseError as e:  # type: ignore[attr-defined]
        raise ValueError(f"Not a valid GPX/XML file: {e}") from e
    if root is None or _local(root.tag) != "gpx":
        raise ValueError("Not a GPX file (root element is not <gpx>)")

    out: list[GpxTrack] = []
    wpts: list[GpxPoint] = []
    for el in root:
        tag = _local(el.tag)
        if tag == "trk":
            name = _child_text(el, "name") or f"Track {sum(t.kind == 'track' for t in out) + 1}"
            pts = [_point(p) for seg in el if _local(seg.tag) == "trkseg" for p in seg if _local(p.tag) == "trkpt"]
            if pts:
                out.append(GpxTrack(name, "track", pts))
        elif tag == "rte":
            name = _child_text(el, "name") or f"Route {sum(t.kind == 'route' for t in out) + 1}"
            pts = [_point(p) for p in el if _local(p.tag) == "rtept"]
            if pts:
                out.append(GpxTrack(name, "route", pts))
        elif tag == "wpt":
            wpts.append(_point(el))
    if wpts:
        out.append(GpxTrack("Waypoints", "waypoints", wpts))
    if not out:
        raise ValueError("The GPX file contains no tracks, routes or waypoints")
    return out


def _fmt_time(dt: datetime) -> str:
    dt = dt.astimezone(timezone.utc)
    ms = dt.microsecond // 1000
    base = dt.strftime("%Y-%m-%dT%H:%M:%S")
    return f"{base}.{ms:03d}Z" if ms else f"{base}Z"


def write_gpx(
    samples: Sequence[TimelinePoint],
    start: Optional[datetime] = None,
    name: str = "Route",
    waypoints: Sequence[tuple[float, float, str]] = (),
) -> str:
    """GPX 1.1 track with one timed <trkpt> per sample (the format `simulate-location play` reads)."""
    start = start or datetime.now(timezone.utc).replace(microsecond=0)
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="iPhone Location Spoofer" xmlns="http://www.topografix.com/GPX/1/1">',
        f"  <metadata><name>{escape(name)}</name><time>{_fmt_time(start)}</time></metadata>",
    ]
    for lat, lon, wname in waypoints:
        lines.append(f'  <wpt lat="{lat:.7f}" lon="{lon:.7f}"><name>{escape(wname)}</name></wpt>')
    lines.append(f"  <trk><name>{escape(name)}</name><trkseg>")
    for p in samples:
        t = start + timedelta(seconds=p.t)
        lines.append(f'    <trkpt lat="{p.lat:.7f}" lon="{p.lon:.7f}"><time>{_fmt_time(t)}</time></trkpt>')
    lines.append("  </trkseg></trk>")
    lines.append("</gpx>")
    return "\n".join(lines) + "\n"


def safe_filename(name: str) -> str:
    base = re.sub(r"[^A-Za-z0-9._ -]+", "_", name).strip(" .") or "route"
    return base[:80]


__all__ = ["GpxPoint", "GpxTrack", "parse_gpx", "write_gpx", "parse_time", "safe_filename"]
