"""Turn a Google Maps link into coordinates or a list of route stops.

Handles the link shapes Google Maps produces (checked against the documented "Maps URLs"
format and links copied from the website / apps):

* place links      .../maps/place/Eiffel+Tower/@48.85,2.29,17z/data=...!3d48.8583701!4d2.2944813
* map views        .../maps/@48.85,2.29,15z
* searches         .../maps/search/?api=1&query=47.59,-122.33   or   /maps/search/eiffel+tower
* query links      .../maps?q=48.85,2.29   ?q=loc:48.85,2.29   ?ll=48.85,2.29   ?daddr=..&saddr=..
* directions       .../maps/dir/?api=1&origin=..&destination=..&waypoints=a|b&travelmode=driving
                   .../maps/dir/Paris/48.86,2.35/Lyon/@...,data=...!1d2.35!2d48.85...!3e0
* short links      https://maps.app.goo.gl/XXXX, https://goo.gl/maps/XXXX (resolved by following redirects)

Stops given as place names are returned with ``lat``/``lon`` = None and a ``query``; the caller
geocodes them.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Optional
from urllib.parse import parse_qs, unquote_plus, urlparse

import httpx

SHORT_HOSTS = {"maps.app.goo.gl", "goo.gl", "g.co"}
GOOGLE_HOST = re.compile(r"(^|\.)google\.[a-z.]+$|(^|\.)googleusercontent\.com$")
COORD = re.compile(r"^\s*(?:loc:\s*)?([-+]?\d{1,2}(?:\.\d+)?)\s*,\s*([-+]?\d{1,3}(?:\.\d+)?)\s*$")
AT_VIEW = re.compile(r"@([-+]?\d{1,2}\.\d+),([-+]?\d{1,3}\.\d+)")
PLACE_PIN = re.compile(r"!3d([-+]?\d{1,2}\.\d+)!4d([-+]?\d{1,3}\.\d+)")
DIR_PAIR = re.compile(r"!1d([-+]?\d{1,3}\.\d+)!2d([-+]?\d{1,2}\.\d+)")
TRAVEL_MODE_DATA = re.compile(r"!3e(\d)")
TRAVEL_MODES = {"driving": "car", "walking": "foot", "bicycling": "bike", "two-wheeler": "car", "transit": "car"}
DATA_MODES = {"0": "car", "1": "bike", "2": "foot", "3": "car", "9": "car"}


class LinkError(ValueError):
    pass


@dataclass
class Stop:
    lat: Optional[float]
    lon: Optional[float]
    name: str = ""
    query: str = ""  # place text to geocode when lat/lon are unknown


@dataclass
class ParsedLink:
    kind: str  # "point" | "route"
    stops: list[Stop] = field(default_factory=list)
    mode: Optional[str] = None  # car | bike | foot
    url: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


def is_google_maps_url(text: str) -> bool:
    try:
        u = urlparse(text.strip())
    except ValueError:
        return False
    host = (u.hostname or "").lower()
    return u.scheme in ("http", "https") and (host in SHORT_HOSTS or bool(GOOGLE_HOST.search(host)))


def _coord(text: str) -> Optional[tuple[float, float]]:
    m = COORD.match(unquote_plus(text or ""))
    if not m:
        return None
    lat, lon = float(m.group(1)), float(m.group(2))
    if -90 <= lat <= 90 and -180 <= lon <= 180:
        return lat, lon
    return None


def _stop(text: str) -> Stop:
    text = unquote_plus(text or "").strip()
    c = _coord(text)
    if c:
        return Stop(c[0], c[1], name=f"{c[0]:.6f}, {c[1]:.6f}")
    return Stop(None, None, name=text, query=text)


def parse(url: str) -> ParsedLink:
    """Parse a full (already resolved) Google Maps URL."""
    url = url.strip()
    u = urlparse(url)
    host = (u.hostname or "").lower()
    if not GOOGLE_HOST.search(host):
        raise LinkError("That is not a Google Maps link")
    qs = {k: v[-1] for k, v in parse_qs(u.query).items()}
    path = u.path
    full = unquote_plus(url)

    # consent.google.com wraps the real link in ?continue=
    if host.startswith("consent.") and "continue" in qs:
        return parse(qs["continue"])

    mode = None
    if "travelmode" in qs:
        mode = TRAVEL_MODES.get(qs["travelmode"].lower())
    m = TRAVEL_MODE_DATA.search(full)
    if mode is None and m and "/dir/" in path:
        mode = DATA_MODES.get(m.group(1))

    # --- directions --------------------------------------------------------------------------
    if qs.get("api") == "1" and path.rstrip("/").endswith("/dir"):
        stops = []
        if qs.get("origin"):
            stops.append(_stop(qs["origin"]))
        for w in (qs.get("waypoints") or "").split("|"):
            if w.strip():
                stops.append(_stop(w))
        if not qs.get("destination"):
            raise LinkError("The directions link has no destination")
        stops.append(_stop(qs["destination"]))
        return ParsedLink("route", stops, mode, url)

    if "saddr" in qs or "daddr" in qs:  # legacy directions
        stops = [_stop(qs["saddr"])] if qs.get("saddr") else []
        for part in re.split(r"\s+to:\s*", qs.get("daddr", "")):
            if part.strip():
                stops.append(_stop(part))
        if stops:
            return ParsedLink("route" if len(stops) > 1 else "point", stops, mode, url)

    if "/dir/" in path:
        segs = [s for s in path.split("/dir/", 1)[1].split("/") if s]
        segs = [s for s in segs if not s.startswith("@") and not s.startswith("data=") and s != "am=t"]
        stops = [_stop(s) for s in segs]
        # Named stops carry their coordinates in the data= blob, in order (!1d<lon>!2d<lat>).
        pairs = [(float(b), float(a)) for a, b in DIR_PAIR.findall(full)]
        named = [s for s in stops if s.lat is None]
        if named and len(pairs) == len(named):  # only trust an exact one-to-one match
            for s, (lat, lon) in zip(named, pairs):
                s.lat, s.lon = lat, lon
        if len(stops) >= 2:
            return ParsedLink("route", stops, mode, url)
        if len(stops) == 1:
            return ParsedLink("point", stops, mode, url)

    # --- single places ------------------------------------------------------------------------
    pin = PLACE_PIN.findall(full)
    if pin:  # the dropped pin / place itself (more precise than the @ view centre)
        lat, lon = float(pin[-1][0]), float(pin[-1][1])
        name = ""
        if "/place/" in path:
            name = unquote_plus(path.split("/place/", 1)[1].split("/")[0])
        return ParsedLink("point", [Stop(lat, lon, name=name or f"{lat:.6f}, {lon:.6f}")], mode, url)

    for key in ("query", "q", "ll", "center", "destination"):
        if qs.get(key):
            return ParsedLink("point", [_stop(qs[key])], mode, url)

    if "/search/" in path:
        text = path.split("/search/", 1)[1].split("/")[0]
        if text:
            return ParsedLink("point", [_stop(text)], mode, url)

    if "/place/" in path:
        text = path.split("/place/", 1)[1].split("/")[0]
        at = AT_VIEW.search(full)
        if at:
            lat, lon = float(at.group(1)), float(at.group(2))
            return ParsedLink("point", [Stop(lat, lon, name=unquote_plus(text))], mode, url)
        return ParsedLink("point", [_stop(text)], mode, url)

    at = AT_VIEW.search(full)
    if at:
        lat, lon = float(at.group(1)), float(at.group(2))
        return ParsedLink("point", [Stop(lat, lon, name=f"{lat:.6f}, {lon:.6f}")], mode, url)

    raise LinkError("Could not find a location in that Google Maps link")


async def resolve(url: str, client: Optional[httpx.AsyncClient] = None, max_hops: int = 6) -> str:
    """Follow a short link's redirects (only to Google hosts) and return the final URL."""
    own = client is None
    client = client or httpx.AsyncClient(timeout=15, follow_redirects=False,
                                         headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
    try:
        current = url.strip()
        for _ in range(max_hops):
            host = (urlparse(current).hostname or "").lower()
            if host not in SHORT_HOSTS:
                return current
            r = await client.get(current)
            loc = r.headers.get("location")
            if r.status_code in (301, 302, 303, 307, 308) and loc:
                nxt = str(httpx.URL(current).join(loc))
                nhost = (urlparse(nxt).hostname or "").lower()
                if nhost not in SHORT_HOSTS and not GOOGLE_HOST.search(nhost):
                    raise LinkError(f"The short link points outside Google Maps ({nhost})")
                current = nxt
                continue
            # Some short links answer 200 with the target embedded in the page.
            m = re.search(r'https://www\.google\.[a-z.]+/maps[^"\'\s<>]+', r.text)
            if m:
                return m.group(0).replace("\\u0026", "&").replace("&amp;", "&")
            raise LinkError(f"Could not resolve the short link (HTTP {r.status_code})")
        raise LinkError("Too many redirects while resolving the short link")
    except httpx.HTTPError as e:
        raise LinkError(f"Could not open the short link: {e.__class__.__name__}") from e
    finally:
        if own:
            await client.aclose()


async def parse_any(url: str, client: Optional[httpx.AsyncClient] = None) -> ParsedLink:
    if not is_google_maps_url(url):
        raise LinkError("Paste a link from Google Maps (google.com/maps/... or maps.app.goo.gl/...)")
    host = (urlparse(url.strip()).hostname or "").lower()
    final = await resolve(url, client) if host in SHORT_HOSTS else url.strip()
    out = parse(final)
    out.url = url.strip()
    return out
