"""Roundabouts are found from the routing service's maneuvers and always driven at roundabout speed."""

import math

import pytest

from spoofer import geo, google_api, routing
from spoofer.profile import Leg, ProfileSettings, Waypoint, build_timeline, roundabout_speed

A = (52.04, -0.77)
SETTINGS = ProfileSettings(default_cruise_kmh=70, accel_ms2=2, decel_ms2=2)


def _ring_route(radius=20.0, approach=400.0):
    """In along a straight road, three-quarters round a roundabout, out along another straight road."""
    entry = geo.destination(A, 90, approach)
    centre = geo.destination(entry, 0, radius)  # driving east, the ring lies to the north (anticlockwise)
    # anticlockwise from the south point: the bearing from the centre decreases
    ring = [geo.destination(centre, (180 - 270 * i / 24) % 360, radius) for i in range(25)]
    exit_ = ring[-1]
    out = geo.destination(exit_, 0, approach)
    pts = [A, entry, *ring[1:], out]
    cum = geo.cumulative(pts)
    s0 = cum[1]
    s1 = cum[len(ring)]
    return pts, (s0, s1), out


def _speeds_between(tl, s0, s1):
    return [p.speed_ms * 3.6 for p in tl.sample(0.2) if s0 + 1 <= p.distance_m <= s1 - 1]


def test_roundabout_is_driven_at_roundabout_speed_by_default():
    pts, (s0, s1), end = _ring_route(20)
    wps = [Waypoint(*A), Waypoint(*end)]
    plain = build_timeline(wps, [Leg(pts, cruise_kmh=70, mode="car")], SETTINGS)
    assert max(_speeds_between(plain, s0, s1)) > 60  # without knowing it's a roundabout: road speed
    tl = build_timeline(wps, [Leg(pts, cruise_kmh=70, mode="car", roundabouts=[(s0, s1)])], SETTINGS)
    on_ring = _speeds_between(tl, s0, s1)
    assert len(tl.roundabouts) == 1
    radius, kmh = tl.roundabouts[0]
    assert radius == pytest.approx(20, rel=0.15)
    assert 20 < kmh < 30 and max(on_ring) <= kmh + 0.5
    assert max(on_ring) - min(on_ring) < 1.0  # steady round the ring, not speeding up inside it
    assert tl.summary()["roundabouts"][0]["speed_kmh"] == kmh
    # braking before the entry, accelerating after the exit, within the set rates
    assert tl.at(tl.duration).speed_ms == 0
    assert tl.duration > plain.duration


def test_roundabout_speed_depends_on_size_and_vehicle():
    assert 15 <= roundabout_speed("car", 5) * 3.6 < 18  # mini roundabout
    assert 20 < roundabout_speed("car", 15) * 3.6 < 25
    assert 34 < roundabout_speed("car", 40) * 3.6 <= 40
    assert roundabout_speed("car", 500) * 3.6 == pytest.approx(40)  # big gyratory: still a roundabout
    assert roundabout_speed("bike", 20) * 3.6 <= 22
    assert roundabout_speed("straight", 20) == roundabout_speed("car", 20)
    assert roundabout_speed("foot", 20) is None  # walkers are slower than any roundabout limit anyway


def test_roundabout_never_speeds_up_a_slow_leg():
    pts, (s0, s1), end = _ring_route(40)
    tl = build_timeline([Waypoint(*A), Waypoint(*end)], [Leg(pts, cruise_kmh=15, mode="car", roundabouts=[(s0, s1)])], SETTINGS)
    assert max(p.speed_ms for p in tl.sample(0.5)) * 3.6 <= 15 + 1e-6


def _osrm_route_with_ring():
    entry = geo.destination(A, 90, 300)
    exit_ = geo.destination(entry, 45, 40)
    end = geo.destination(exit_, 0, 300)
    coords = [[p[1], p[0]] for p in (A, entry, geo.destination(entry, 20, 20), exit_, end)]
    steps = [
        {"maneuver": {"type": "depart", "location": coords[0]}, "distance": 300},
        {"maneuver": {"type": "roundabout", "exit": 2, "location": coords[1]}, "distance": 45},
        {"maneuver": {"type": "exit roundabout", "location": coords[3]}, "distance": 300},
        {"maneuver": {"type": "arrive", "location": coords[4]}, "distance": 0},
    ]
    return {"duration": 60, "distance": 650, "geometry": {"coordinates": coords},
            "legs": [{"steps": steps, "annotation": {"speed": [20, 20, 20, 20], "nodes": [1, 2, 3, 4, 5]}}]}, entry, exit_


def test_osrm_roundabout_steps_become_distance_ranges():
    rt, entry, exit_ = _osrm_route_with_ring()
    c = routing._parse_osrm(rt, "main")
    assert len(c.roundabouts) == 1
    full = [A, *c.pts, geo.destination(c.pts[-1], 0, 30)]
    ranges = routing.roundabout_ranges(full, c.roundabouts)
    cum = geo.cumulative(full)
    assert ranges == [(pytest.approx(cum[2], abs=0.2), pytest.approx(cum[4], abs=0.2))]
    # a mini roundabout ("roundabout turn") is a short stretch around its point
    rt["legs"][0]["steps"][1]["maneuver"]["type"] = "roundabout turn"
    mini = routing.roundabout_ranges(full, routing._parse_osrm(rt, "main").roundabouts)
    assert len(mini) == 1 and mini[0][1] - mini[0][0] == pytest.approx(2 * routing.MINI_ROUNDABOUT_M, abs=0.2)


def test_google_roundabout_steps_are_kept():
    pts = [A, geo.destination(A, 90, 300), geo.destination(A, 90, 600)]
    g = google_api.GoogleRoute(points=pts, duration_s=60, static_duration_s=60, distance_m=600, steps=[
        {"start_m": 0, "end_m": 280, "speed_ms": 15, "maneuver": "DEPART"},
        {"start_m": 280, "end_m": 330, "speed_ms": 15, "maneuver": "ROUNDABOUT_LEFT"},
        {"start_m": 330, "end_m": 600, "speed_ms": 15, "maneuver": "STRAIGHT"},
    ])
    res = routing._google_result(A, pts[-1], "car", g)
    assert res.roundabouts == [(pytest.approx(280, abs=1), pytest.approx(330, abs=1))]
    assert res.features["roundabouts"] == 1
    assert math.isclose(res.points[0][0], A[0])
