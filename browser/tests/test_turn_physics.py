"""Cornering physics: every bend is taken at the speed its radius and the vehicle allow."""

import math

import pytest

from spoofer import geo
from spoofer.profile import (
    VEHICLES,
    Leg,
    ProfileSettings,
    Waypoint,
    build_timeline,
    turn_speed,
    vehicle_for,
)

A = (51.5, -0.12)
KMH = 3.6
TURNS = ProfileSettings(accel_ms2=2, decel_ms2=2, corner_slowdown=True)


def _min_speed_near(tl, point, within=15.0):
    pts = [p for p in tl.sample(0.25) if geo.haversine_m((p.lat, p.lon), point) < within]
    return min(p.speed_ms for p in pts) * KMH


def _junction(angle_deg, approach=400.0, exit_len=400.0, mode="car", cruise=50.0):
    """A straight road, one sharp corner (as maps draw junctions), another straight road."""
    corner = geo.destination(A, 90, approach)
    end = geo.destination(corner, 90 + angle_deg, exit_len)
    wps = [Waypoint(*A), Waypoint(*end)]
    return build_timeline(wps, [Leg([A, corner, end], cruise_kmh=cruise, mode=mode)], TURNS), corner


def _arc(radius, angle_deg, step=10.0, lead=400.0):
    """A straight, then a circular curve of the given radius drawn as many short segments, then a straight."""
    pts = [A, geo.destination(A, 90, lead)]
    start = pts[-1]
    centre = geo.destination(start, 180, radius)  # turning right (clockwise)
    n = max(2, int(math.radians(angle_deg) * radius / step))
    for i in range(1, n + 1):
        brg = (0 + angle_deg * i / n) % 360  # from due north of the centre, clockwise
        pts.append(geo.destination(centre, brg, radius))
    heading = 90 + angle_deg
    pts.append(geo.destination(pts[-1], heading, lead))
    return pts


def test_turn_speed_follows_radius_and_vehicle():
    car = VEHICLES["car"]
    # a 90° junction rounded on a ~10 m arc: about 18 km/h, the speed people really take it at
    assert 15 < turn_speed(car, 9.7) * KMH < 22
    # a U-turn on the car's own turning circle (5.5 m): about 14 km/h
    assert 11 < turn_speed(car, 0.0) * KMH < 16
    # a roundabout (15 m): about 22 km/h
    assert 19 < turn_speed(car, 15) * KMH < 27
    # a motorway curve of 300 m: close to the design speed for that radius (about 85 km/h)
    assert 78 < turn_speed(car, 300) * KMH < 92
    # a wide curve barely slows a car at motorway speed
    assert turn_speed(car, 600) * KMH > 115
    # bikes and walkers take the same corner at their own pace
    assert 7 < turn_speed(VEHICLES["bike"], 3.0) * KMH < 12
    assert 3.5 < turn_speed(VEHICLES["foot"], 0.83) * KMH < 5
    # never faster than the grip allows
    for r in (5, 50, 500, 5000):
        v = turn_speed(car, r)
        assert v <= math.sqrt(car.grip * car.safety * 9.81 * r) + 1e-9
    # higher allowed sideways force (sportier driving) means faster corners
    assert turn_speed(car, 30, a_scale=1.44) > turn_speed(car, 30)


def test_sharp_junction_is_slowed_to_its_cornering_speed():
    tl, corner = _junction(90)
    assert tl.corners_slowed == 1 and len(tl.turns) == 1
    t = tl.turns[0]
    assert t.angle_deg == pytest.approx(90, abs=1) and 6 < t.radius_m < 14
    assert 14 < _min_speed_near(tl, corner) < 23
    s = tl.summary()
    assert s["sharpest_turn"]["angle_deg"] == pytest.approx(90, abs=1)
    assert s["turns"] == 1
    # gentle angles are taken faster than sharp ones; tiny ones not slowed at all
    assert _min_speed_near(_junction(35)[0], corner) > _min_speed_near(tl, corner) + 8
    gentle, c2 = _junction(6)
    assert gentle.turns == [] and _min_speed_near(gentle, c2) > 49


def test_curved_road_uses_its_drawn_radius():
    pts = _arc(120, 90)
    end = pts[-1]
    tl = build_timeline([Waypoint(*A), Waypoint(*end)], [Leg(pts, cruise_kmh=90, mode="car")], TURNS)
    assert len(tl.turns) == 1
    t = tl.turns[0]
    assert t.angle_deg == pytest.approx(90, abs=3)
    assert t.radius_m == pytest.approx(120, rel=0.15)
    expected = turn_speed(VEHICLES["car"], t.radius_m) * KMH
    assert t.speed_kmh == pytest.approx(expected, abs=0.2)
    assert 52 < t.speed_kmh < 66  # 120 m drawn, a little straighter driven: about 60 km/h


def test_s_bend_is_two_turns_and_u_turn_uses_turning_circle():
    a = A
    b = geo.destination(a, 90, 300)
    c = geo.destination(b, 0, 60)
    d = geo.destination(c, 90, 300)
    tl = build_timeline([Waypoint(*a), Waypoint(*d)], [Leg([a, b, c, d], cruise_kmh=50, mode="car")], TURNS)
    assert len(tl.turns) == 2
    assert tl.turns[0].angle_deg < 0 < tl.turns[1].angle_deg  # left, then right
    far = geo.destination(a, 90, 500)
    back = geo.destination(far, 270, 500)
    tl = build_timeline([Waypoint(*a), Waypoint(*back)], [Leg([a, far, back], cruise_kmh=50, mode="car")], TURNS)
    assert len(tl.turns) == 1 and tl.turns[0].radius_m == pytest.approx(VEHICLES["car"].min_radius, abs=0.6)


def test_junctions_on_faster_roads_are_taken_wider():
    slow = _junction(90, cruise=30)[0].turns[0]
    mid = _junction(90, cruise=50)[0].turns[0]
    fast = _junction(90, cruise=80)[0].turns[0]
    assert slow.radius_m < mid.radius_m < fast.radius_m
    assert slow.speed_kmh < mid.speed_kmh < fast.speed_kmh < 30


def test_vehicle_follows_the_leg_mode():
    car, corner = _junction(90, mode="car")
    bike, _ = _junction(90, mode="bike", cruise=18)
    foot, _ = _junction(90, mode="foot", cruise=5)
    assert _min_speed_near(bike, corner) < 12
    assert _min_speed_near(foot, corner) < 5 and _min_speed_near(foot, corner) > 3
    # straight legs guess the vehicle from their speed; a plane is not slowed for a checkpoint corner
    plane, c2 = _junction(90, approach=40000, exit_len=40000, mode="straight", cruise=850)
    assert plane.turns == [] and _min_speed_near(plane, c2, within=400) > 800
    assert vehicle_for("straight", 50 / KMH) is VEHICLES["car"]
    assert vehicle_for("straight", 4 / KMH) is VEHICLES["foot"]
    assert vehicle_for("sea", 30 / KMH) is VEHICLES["sea"]


def test_brakes_before_the_turn_and_accelerates_after():
    tl, corner = _junction(90)
    samples = tl.sample(0.25)
    i = min(range(len(samples)), key=lambda k: geo.haversine_m((samples[k].lat, samples[k].lon), corner))
    before = [p.speed_ms for p in samples[max(0, i - 40):i]]
    after = [p.speed_ms for p in samples[i:i + 40]]
    assert all(x >= y - 1e-6 for x, y in zip(before, before[1:]))  # slowing down into it
    assert all(y >= x - 1e-6 for x, y in zip(after, after[1:]))  # speeding up out of it
    # the deceleration stays within the configured braking rate
    for p, q in zip(samples, samples[1:]):
        if q.t > p.t:
            assert (p.speed_ms - q.speed_ms) / (q.t - p.t) <= 2.0 + 0.05


def test_lateral_override_and_floor():
    corner = geo.destination(A, 90, 400)
    end = geo.destination(corner, 180, 400)
    legs = [Leg([A, corner, end], cruise_kmh=50, mode="car")]
    soft = build_timeline([Waypoint(*A), Waypoint(*end)], legs,
                          ProfileSettings(accel_ms2=2, decel_ms2=2, corner_slowdown=True, lateral_accel_ms2=1.0))
    firm = build_timeline([Waypoint(*A), Waypoint(*end)], legs, TURNS)
    assert soft.turns[0].speed_kmh < firm.turns[0].speed_kmh
    floored = build_timeline([Waypoint(*A), Waypoint(*end)], legs,
                             ProfileSettings(accel_ms2=2, decel_ms2=2, corner_slowdown=True, min_corner_kmh=30))
    assert floored.turns[0].speed_kmh == pytest.approx(30, abs=0.1)
