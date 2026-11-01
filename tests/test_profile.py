import math

import pytest

from spoofer import geo
from spoofer.profile import Leg, ProfileSettings, Waypoint, build_timeline, timeline_from_timed_points

A = (51.5, -0.12)


def straight(dist_m, bearing=90.0):
    b = geo.destination(A, bearing, dist_m)
    return [Waypoint(*A), Waypoint(*b)], [Leg([A, b])], b


def test_trapezoid_matches_closed_form():
    wps, legs, _ = straight(1000)
    legs[0].cruise_kmh = 36  # 10 m/s
    tl = build_timeline(wps, legs, ProfileSettings(accel_ms2=1, decel_ms2=2))
    # accel 0->10 at 1: 10 s / 50 m; brake 10->0 at 2: 5 s / 25 m; cruise 925 m at 10 m/s: 92.5 s
    assert tl.duration == pytest.approx(107.5, abs=0.05)
    assert tl.distance == pytest.approx(1000, abs=0.5)
    assert tl.at(5).speed_ms == pytest.approx(5, abs=0.05)
    assert tl.at(5).distance_m == pytest.approx(12.5, abs=0.1)
    assert tl.at(50).speed_ms == pytest.approx(10, abs=1e-6)
    assert tl.at(tl.duration).speed_ms == pytest.approx(0, abs=0.1)


def test_triangle_when_leg_too_short():
    wps, legs, _ = straight(50)
    legs[0].cruise_kmh = 100
    tl = build_timeline(wps, legs, ProfileSettings(accel_ms2=1, decel_ms2=1))
    # peak v = sqrt(a*L) = sqrt(50); time = 2*sqrt(L/a)*... = 2*sqrt(50)
    assert tl.max_speed == pytest.approx(math.sqrt(50), rel=0.01)
    assert tl.duration == pytest.approx(2 * math.sqrt(50), rel=0.01)


def test_linear_ramp_uniform_over_leg():
    wps, legs, _ = straight(1000)
    wps[0].speed_kmh = 0
    wps[1].speed_kmh = 72  # 20 m/s
    legs[0].ramp = "linear"
    tl = build_timeline(wps, legs, ProfileSettings(stop_at_end=False))
    assert tl.duration == pytest.approx(100, rel=0.005)  # t = 2L/(v0+v1)
    # constant acceleration a = v1^2/(2L) = 0.2 m/s^2  ->  v(t) = 0.2 t
    for t in (10, 37, 80):
        assert tl.at(t).speed_ms == pytest.approx(0.2 * t, abs=0.05)


def test_speed_checkpoint_and_dwell():
    b = geo.destination(A, 0, 500)
    c = geo.destination(b, 0, 500)
    wps = [Waypoint(*A), Waypoint(*b, dwell_s=30), Waypoint(*c, speed_kmh=18)]
    legs = [Leg([A, b], cruise_kmh=36), Leg([b, c], cruise_kmh=36)]
    tl = build_timeline(wps, legs, ProfileSettings(accel_ms2=1, decel_ms2=1, stop_at_end=False))
    arrive_b = tl.waypoint_times[1]
    # stationary at b for 30 s
    p1, p2 = tl.at(arrive_b + 1), tl.at(arrive_b + 29)
    assert p1.speed_ms == 0 and p2.speed_ms == 0
    assert geo.haversine_m((p1.lat, p1.lon), b) < 0.5
    assert tl.at(tl.duration).speed_ms == pytest.approx(5, abs=0.05)
    assert not tl.warnings


def test_unreachable_checkpoint_warns():
    wps, legs, _ = straight(20)
    wps[1].speed_kmh = 200
    legs[0].cruise_kmh = 200
    tl = build_timeline(wps, legs, ProfileSettings(accel_ms2=1))
    assert tl.warnings and "Waypoint 2" in tl.warnings[0]


def test_linear_zero_both_ends_rejected():
    wps, legs, _ = straight(100)
    legs[0].ramp = "linear"
    with pytest.raises(ValueError, match="linear"):
        build_timeline(wps, legs, ProfileSettings())


def test_validation():
    wps, legs, _ = straight(100)
    with pytest.raises(ValueError):
        build_timeline(wps[:1], [], ProfileSettings())
    with pytest.raises(ValueError):
        build_timeline(wps, legs, ProfileSettings(accel_ms2=0))
    with pytest.raises(ValueError):
        build_timeline([Waypoint(95, 0), wps[1]], legs, ProfileSettings())


def test_samples_monotonic_and_end_included():
    wps, legs, _ = straight(333)
    tl = build_timeline(wps, legs, ProfileSettings(default_cruise_kmh=7))
    s = tl.sample(1.0)
    assert s[0].t == 0
    assert s[-1].t == pytest.approx(tl.duration)
    assert all(b.t > a.t for a, b in zip(s, s[1:]))
    assert all(b.distance_m >= a.distance_m - 1e-6 for a, b in zip(s, s[1:]))


def test_long_route_is_bounded():
    b = (40.6, -74.0)
    a = (49.5, 0.1)
    tl = build_timeline([Waypoint(*a), Waypoint(*b)], [Leg([a, b], cruise_kmh=800)], ProfileSettings())
    assert len(tl.segments) <= 61_000
    assert tl.distance == pytest.approx(geo.haversine_m(a, b), rel=1e-3)


def test_timed_points():
    b = geo.destination(A, 90, 100)
    tl = timeline_from_timed_points([(0, *A), (20, *b)])
    assert tl.duration == 20
    assert tl.at(10).distance_m == pytest.approx(50, abs=0.1)
