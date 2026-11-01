import asyncio
import json

import httpx
import pytest

from spoofer import geo, gmaps_links, google_api, road_speed, routing
from spoofer.profile import Leg, ProfileSettings, Waypoint, build_matching_eta, build_timeline


# ---------------------------------------------------------------- Google Maps links
@pytest.mark.parametrize(
    "url,lat,lon",
    [
        ("https://www.google.com/maps/place/Eiffel+Tower/@48.8583701,2.2919064,17z/data=!3m1!4b1!4m6!3m5!1s0x47e66e2964e34e2d:0x8ddca9ee380ef7e0!8m2!3d48.8583701!4d2.2944813",
         48.8583701, 2.2944813),
        ("https://www.google.com/maps/@40.7127753,-74.0059728,15z", 40.7127753, -74.0059728),
        ("https://www.google.com/maps/search/?api=1&query=47.5951518%2C-122.3316393", 47.5951518, -122.3316393),
        ("https://maps.google.com/maps?q=loc:-33.8688,151.2093", -33.8688, 151.2093),
        ("https://www.google.co.uk/maps?ll=51.5072,-0.1276&z=12", 51.5072, -0.1276),
        ("https://www.google.com/maps/search/19.0761,+72.8775", 19.0761, 72.8775),
    ],
)
def test_point_links(url, lat, lon):
    p = gmaps_links.parse(url)
    assert p.kind == "point"
    assert p.stops[0].lat == pytest.approx(lat) and p.stops[0].lon == pytest.approx(lon)


def test_directions_api_link():
    p = gmaps_links.parse(
        "https://www.google.com/maps/dir/?api=1&origin=48.85,2.29&destination=48.86,2.35"
        "&waypoints=48.855,2.30%7CLouvre+Museum&travelmode=walking"
    )
    assert p.kind == "route" and p.mode == "foot"
    assert [s.lat for s in p.stops] == [48.85, 48.855, None, 48.86]
    assert p.stops[2].query == "Louvre Museum"


def test_directions_path_link_with_data_coordinates():
    url = ("https://www.google.com/maps/dir/Eiffel+Tower,+Paris/48.8606,2.3376/Arc+de+Triomphe/"
           "@48.86,2.31,14z/data=!4m14!4m13!1m5!1m1!1s0x0:0x1!2m2!1d2.2944813!2d48.8583701"
           "!1m0!1m5!1m1!1s0x0:0x2!2m2!1d2.2950275!2d48.8737917!3e0")
    p = gmaps_links.parse(url)
    assert p.kind == "route" and p.mode == "car" and len(p.stops) == 3
    assert p.stops[0].lat == pytest.approx(48.8583701) and p.stops[0].lon == pytest.approx(2.2944813)
    assert p.stops[1].lat == pytest.approx(48.8606)
    assert p.stops[2].lat == pytest.approx(48.8737917)


def test_consent_wrapper_and_rejects():
    inner = "https://www.google.com/maps/@10.5,20.25,10z"
    from urllib.parse import quote

    p = gmaps_links.parse("https://consent.google.com/m?continue=" + quote(inner, safe=""))
    assert p.stops[0].lat == 10.5
    with pytest.raises(gmaps_links.LinkError):
        gmaps_links.parse("https://example.com/maps/@1,2,3z")
    with pytest.raises(gmaps_links.LinkError):
        asyncio.run(gmaps_links.parse_any("not a link"))


def test_short_link_resolution():
    def handler(req):
        if req.url.host == "maps.app.goo.gl":
            return httpx.Response(302, headers={"Location": "https://www.google.com/maps/@1.5,2.5,10z"})
        return httpx.Response(200, text="")

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            return await gmaps_links.parse_any("https://maps.app.goo.gl/abc123", c)

    p = asyncio.run(run())
    assert (p.stops[0].lat, p.stops[0].lon) == (1.5, 2.5)


def test_short_link_to_foreign_host_refused():
    def handler(req):
        return httpx.Response(302, headers={"Location": "https://evil.example/maps/@1,2,3z"})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            return await gmaps_links.parse_any("https://maps.app.goo.gl/x", c)

    with pytest.raises(gmaps_links.LinkError):
        asyncio.run(run())


# ---------------------------------------------------------------- Google API
def test_decode_polyline_reference_example():
    # Example from Google's "Encoded Polyline Algorithm Format" documentation
    pts = google_api.decode_polyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@")
    assert pts == [(38.5, -120.2), (40.7, -120.95), (43.252, -126.453)]


def _encode(points):
    def enc(v):
        v = ~(v << 1) if v < 0 else v << 1
        out = ""
        while v >= 0x20:
            out += chr((0x20 | (v & 0x1F)) + 63)
            v >>= 5
        return out + chr(v + 63)

    res, plat, plon = "", 0, 0
    for lat, lon in points:
        ilat, ilon = round(lat * 1e5), round(lon * 1e5)
        res += enc(ilat - plat) + enc(ilon - plon)
        plat, plon = ilat, ilon
    return res


def test_google_route_zones_and_not_exportable(monkeypatch):
    a = (51.5, -0.12)
    mid = geo.destination(a, 90, 1000)
    b = geo.destination(mid, 90, 1000)
    seen = {}

    def handler(req):
        seen["key"] = req.headers.get("X-Goog-Api-Key")
        seen["mask"] = req.headers.get("X-Goog-FieldMask")
        seen["body"] = json.loads(req.content)
        return httpx.Response(200, json={"routes": [{
            "duration": "200s", "staticDuration": "180s", "distanceMeters": 2000,
            "polyline": {"encodedPolyline": _encode([a, mid, b])},
            "legs": [{"steps": [
                {"distanceMeters": 1000, "staticDuration": "100s", "navigationInstruction": {"maneuver": "DEPART"}},
                {"distanceMeters": 1000, "staticDuration": "50s", "navigationInstruction": {"maneuver": "UTURN_LEFT"}},
            ]}],
        }]})

    monkeypatch.setattr(routing, "_client", httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    res = asyncio.run(routing.route(a, b, "car", provider="google", google_key="KEY"))
    assert seen["key"] == "KEY" and "routes.legs.steps.staticDuration" in seen["mask"]
    assert seen["body"]["travelMode"] == "DRIVE" and seen["body"]["routingPreference"] == "TRAFFIC_AWARE"
    assert res.provider == "google" and not res.exportable
    assert res.ref_duration_s == 200
    assert res.features["uturns"] == 1
    speeds = [v for _, v in res.zones if v]
    assert min(speeds) == pytest.approx(10, rel=0.05) and max(speeds) == pytest.approx(20, rel=0.05)


def test_google_without_key_errors():
    with pytest.raises(routing.RoutingError, match="API key"):
        asyncio.run(routing.route((0, 0), (0.01, 0.01), "car", provider="google"))


# ---------------------------------------------------------------- OSRM + speed limits
def test_osrm_annotations_offnet_and_overpass(monkeypatch):
    a = (51.5, -0.12)
    s1 = geo.destination(a, 0, 60)  # the waypoint is 60 m off the road network
    s2 = geo.destination(s1, 90, 500)
    s3 = geo.destination(s2, 90, 500)
    b = s3

    def handler(req):
        if "routed-car" in str(req.url):
            return httpx.Response(200, json={"code": "Ok", "routes": [{
                "duration": 80.0,
                "geometry": {"coordinates": [[p[1], p[0]] for p in (s1, s2, s3)]},
                "legs": [{"annotation": {"speed": [10.0, 20.0], "nodes": [1, 2, 3]},
                          "steps": [{"maneuver": {"type": "turn", "modifier": "uturn"}}]}],
            }]})
        if "interpreter" in str(req.url):
            return httpx.Response(200, json={"elements": [
                {"type": "way", "nodes": [1, 2], "tags": {"highway": "residential", "maxspeed": "20 mph"}},
                {"type": "way", "nodes": [2, 3], "tags": {"highway": "service", "access": "private"}},
            ]})
        return httpx.Response(404)

    monkeypatch.setattr(routing, "_client", httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    routing._cache.clear()
    res = asyncio.run(routing.route(a, b, "car", road_data=True))
    assert res.points[0] == a and res.points[-1] == b
    assert res.features["offnet_m"] == pytest.approx(60, abs=1)
    assert res.features["uturns"] == 1 and res.features["restricted_segments"] == 1
    zone_speeds = [v for _, v in res.zones]
    assert zone_speeds[0] == pytest.approx(15 / 3.6)  # off-network join: possible gated road
    assert zone_speeds[1] == pytest.approx(min(10.0, 20 * 1.609344 / 3.6))  # capped by the 20 mph limit
    assert zone_speeds[2] == pytest.approx(20 / 3.6)  # private road cap
    assert res.ref_duration_s == 80.0


def test_overpass_failure_is_graceful(monkeypatch):
    a, b = (51.5, -0.12), (51.51, -0.12)

    def handler(req):
        if "interpreter" in str(req.url):
            return httpx.Response(504)
        return httpx.Response(200, json={"code": "Ok", "routes": [{
            "duration": 60.0, "geometry": {"coordinates": [[a[1], a[0]], [b[1], b[0]]]},
            "legs": [{"annotation": {"speed": [15.0], "nodes": [1, 2]}, "steps": []}]}]})

    monkeypatch.setattr(routing, "_client", httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    routing._cache.clear()
    res = asyncio.run(routing.route(a, b, "car", road_data=True))
    assert any("unavailable" in n for n in res.notes)
    assert [v for _, v in res.zones][1] == 15.0


@pytest.mark.parametrize("tag,kmh", [("50", 50), ("30 mph", 48.28), ("DE:urban", 50), ("50;30", 30),
                                     ("walk", 7), ("none", None), ("signals", None), (None, None)])
def test_parse_maxspeed(tag, kmh):
    v = road_speed.parse_maxspeed(tag)
    assert (v is None and kmh is None) or v == pytest.approx(kmh, abs=0.01)


# ---------------------------------------------------------------- profile: road-aware + corners + ETA
def _uturn_leg():
    a = (51.5, -0.12)
    far = geo.destination(a, 90, 500)
    back = geo.destination(far, 270, 500)
    return a, far, back


def test_corner_slowdown_slows_uturn():
    a, far, back = _uturn_leg()
    wps = [Waypoint(*a), Waypoint(*back)]
    legs = [Leg([a, far, back], cruise_kmh=50)]
    plain = build_timeline(wps, legs, ProfileSettings(accel_ms2=2, decel_ms2=2))
    slowed = build_timeline(wps, legs, ProfileSettings(accel_ms2=2, decel_ms2=2, corner_slowdown=True))
    assert slowed.duration > plain.duration
    assert slowed.corners_slowed == 1
    # speed at the turnaround point is close to the minimum corner speed
    t_turn = min(slowed.sample(0.5), key=lambda p: geo.haversine_m((p.lat, p.lon), far)).t
    assert slowed.at(t_turn).speed_ms < 12 / 3.6


def test_road_aware_follows_zones():
    a = (51.5, -0.12)
    b = geo.destination(a, 90, 2000)
    zones = [(1000.0, 10.0), (2000.0, 25.0)]
    s = ProfileSettings(road_aware=True, accel_ms2=3, decel_ms2=3, default_cruise_kmh=5)
    tl = build_timeline([Waypoint(*a), Waypoint(*b)], [Leg([a, b], zones=zones)], s)
    assert tl.max_speed == pytest.approx(25.0, rel=0.01)
    p = min(tl.sample(1), key=lambda q: abs(q.distance_m - 500))
    assert p.speed_ms == pytest.approx(10.0, rel=0.02)
    # an explicit leg cruise speed still limits the road speed
    tl2 = build_timeline([Waypoint(*a), Waypoint(*b)], [Leg([a, b], cruise_kmh=36, zones=zones)], s)
    assert tl2.max_speed == pytest.approx(10.0, rel=0.01)


def test_eta_matching_moves_towards_reference():
    a = (51.5, -0.12)
    b = geo.destination(a, 90, 5000)
    zones = [(5000.0, 20.0)]
    s = ProfileSettings(road_aware=True, accel_ms2=2, decel_ms2=2)
    base = build_timeline([Waypoint(*a), Waypoint(*b)], [Leg([a, b], zones=zones)], s)
    target = base.duration * 1.25  # the service expects a slower drive
    tl, factor = build_matching_eta([Waypoint(*a), Waypoint(*b)], [Leg([a, b], zones=zones)], s, target)
    assert factor < 1.0
    assert tl.duration == pytest.approx(target, rel=0.04)
    # clamped: an impossible reference does not produce absurd speeds
    tl3, f3 = build_matching_eta([Waypoint(*a), Waypoint(*b)], [Leg([a, b], zones=zones)], s, base.duration * 10)
    assert f3 == pytest.approx(0.6)
