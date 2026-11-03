"""Speed-profile engine.

Turns a routed path plus speed checkpoints into a timeline: where the device is at every
moment, with uniform (constant) acceleration and deceleration between speeds.

Model
-----
* The route is a list of *legs*; leg i runs from waypoint i to waypoint i+1 along its
  routed geometry (road, sea lane, straight line, ...).
* Every leg has a cruise speed (its speed limit) and a ramp mode:
    - ``"accel"``: speed changes at the configured acceleration / deceleration rate
      (m/s^2). The device accelerates as early and brakes as late as possible, holding
      cruise speed in between (a trapezoidal profile, triangular if the leg is short).
    - ``"linear"``: speed changes uniformly over the *whole* leg, from the speed at its
      first waypoint to the speed at its last waypoint (one constant acceleration for the
      entire leg), ignoring the acceleration settings.
* A waypoint may pin an exact speed (a *speed checkpoint*), or a dwell time (a stop:
  speed 0 there, then wait). Unpinned waypoints are passed at whatever speed the
  surrounding limits allow.

The solver densifies the path, caps the speed at every node, then runs a forward pass
(acceleration limit) and a backward pass (deceleration limit) - the standard
motion-planning approach that yields the fastest profile obeying every limit. Inside each
small step the acceleration is constant, so v^2 changes linearly with distance and the
position at any time has a closed form.
"""

from __future__ import annotations

import bisect
import math
from dataclasses import dataclass, field, replace
from typing import Optional, Sequence

from . import geo

KMH = 1 / 3.6  # km/h -> m/s
MIN_MOVING_SPEED = 0.05  # m/s; below this on both ends of a step the step never finishes
MAX_NODES = 60_000
# The heading reported while moving is the direction of the path over a short window around the
# current spot (a car turns over several metres, not at a polyline vertex): about 0.8 s of travel.
HEADING_WINDOW_S = 0.8
HEADING_WINDOW_MIN_M = 2.0
HEADING_WINDOW_MAX_M = 12.0


@dataclass
class Waypoint:
    lat: float
    lon: float
    speed_kmh: Optional[float] = None  # exact speed when passing this point
    dwell_s: float = 0.0  # stop here (speed 0) for this many seconds
    hold: bool = False  # stop here and wait until the user presses Continue (then any dwell_s)


@dataclass
class Leg:
    points: list[geo.LatLon]  # routed geometry, first/last should be the waypoints
    cruise_kmh: Optional[float] = None  # None -> settings.default_cruise_kmh
    ramp: str = "accel"  # "accel" | "linear"
    # How the leg is travelled (car, bike, foot, sea, straight): picks the vehicle whose cornering
    # limits apply. Straight legs guess the vehicle from their speed.
    mode: str = "straight"
    # Road-aware mode: typical speed (m/s, None = unknown) up to each distance along the leg,
    # as reported by the routing service / speed-limit data. Sorted by distance.
    zones: Optional[list[tuple[float, Optional[float]]]] = None


@dataclass
class ProfileSettings:
    default_cruise_kmh: float = 5.0
    accel_ms2: float = 1.0
    decel_ms2: float = 1.0
    start_from_rest: bool = True  # first waypoint speed 0 unless it pins one
    stop_at_end: bool = True  # last waypoint speed 0 unless it pins one
    max_step_m: float = 2.0
    # --- experimental road-aware driving ---
    road_aware: bool = False  # follow per-road typical speeds / limits from the routing data
    speed_factor: float = 1.0  # multiply road speeds (driving style); tuned by ETA matching
    corner_slowdown: bool = False  # take every bend at the speed its radius and the vehicle allow
    # Override the vehicle's comfortable lateral acceleration at low speed (m/s^2); None = the
    # vehicle's own (see VEHICLES). Its fall-off at speed scales along.
    lateral_accel_ms2: Optional[float] = None
    min_corner_kmh: float = 0.0  # optional floor for planned turn speeds


@dataclass
class Segment:
    """One piece of the timeline with constant acceleration (or standing still)."""

    t0: float
    t1: float
    p0: geo.LatLon
    p1: geo.LatLon
    v0: float  # m/s at t0
    v1: float  # m/s at t1
    ds: float  # metres
    s0: float  # cumulative distance at p0


@dataclass
class TimelinePoint:
    t: float
    lat: float
    lon: float
    speed_ms: float
    course: float
    distance_m: float


@dataclass
class Timeline:
    segments: list[Segment]
    waypoint_times: list[float] = field(default_factory=list)  # arrival time per waypoint
    warnings: list[str] = field(default_factory=list)
    dwell_total: float = 0.0  # seconds spent waiting at checkpoints
    corners_slowed: int = 0
    turns: list["Turn"] = field(default_factory=list)  # every bend found (see detect_turns)
    # (time, waypoint index) of every "hold until Continue" checkpoint: the moment the device
    # comes to a stop there, before any wait time.
    holds: list[tuple[float, int]] = field(default_factory=list)

    def __post_init__(self) -> None:
        self._t0s = [s.t0 for s in self.segments]
        # moving segments by distance, for the heading window
        self._moving = [s for s in self.segments if s.ds > 0]
        self._s0s = [s.s0 for s in self._moving]

    @property
    def duration(self) -> float:
        return self.segments[-1].t1 if self.segments else 0.0

    @property
    def distance(self) -> float:
        if not self.segments:
            return 0.0
        last = self.segments[-1]
        return last.s0 + last.ds

    @property
    def max_speed(self) -> float:
        return max((max(s.v0, s.v1) for s in self.segments), default=0.0)

    def at(self, t: float) -> TimelinePoint:
        """State at time t (clamped to the timeline)."""
        if not self.segments:
            raise ValueError("Empty timeline")
        t = min(max(t, 0.0), self.duration)
        i = max(0, bisect.bisect_right(self._t0s, t) - 1)
        seg = self.segments[i]
        tau = t - seg.t0
        if seg.ds <= 0 or seg.t1 <= seg.t0:
            s, v = 0.0, seg.v0 if seg.ds > 0 else 0.0
        else:
            dur = seg.t1 - seg.t0
            a = (seg.v1 - seg.v0) / dur
            s = seg.v0 * tau + 0.5 * a * tau * tau
            v = seg.v0 + a * tau
            s = min(max(s, 0.0), seg.ds)
        f = s / seg.ds if seg.ds > 0 else 0.0
        lat, lon = geo.interpolate(seg.p0, seg.p1, f)
        v = max(v, 0.0)
        course = self.heading_at(seg.s0 + s, v, moving=v > MIN_MOVING_SPEED)
        if course is None:
            course = geo.bearing_deg(seg.p0, seg.p1) if seg.ds > 0 else self._last_course(i)
        return TimelinePoint(t, lat, lon, v, course, seg.s0 + s)

    def point_at_distance(self, s: float) -> Optional[geo.LatLon]:
        """Position at distance s (m) along the path, clamped to it."""
        if not self._moving:
            return None
        s = min(max(s, 0.0), self.distance)
        i = max(0, bisect.bisect_right(self._s0s, s) - 1)
        seg = self._moving[i]
        return geo.interpolate(seg.p0, seg.p1, min(1.0, max(0.0, (s - seg.s0) / seg.ds)))

    def heading_at(self, s: float, speed_ms: float, moving: bool = True) -> Optional[float]:
        """Direction of travel at distance s: the path's bearing over a short window, so the
        heading turns smoothly through corners instead of jumping at each polyline vertex.
        Standing still, the device faces the way it arrived (or, at the start, the way it leaves)."""
        if not self._moving:
            return None
        w = min(HEADING_WINDOW_MAX_M, max(HEADING_WINDOW_MIN_M, speed_ms * HEADING_WINDOW_S))
        total = self.distance
        if moving:
            a, b = s - w, s + w
        elif s - 2 * w >= 0:
            a, b = s - 2 * w, s
        else:
            a, b = s, s + 2 * w
        a, b = max(0.0, a), min(total, b)
        if b - a < 0.5:
            return None
        pa, pb = self.point_at_distance(a), self.point_at_distance(b)
        if pa is None or pb is None or geo.haversine_m(pa, pb) < 0.3:
            return None
        return geo.bearing_deg(pa, pb)

    def _last_course(self, i: int) -> float:
        for j in range(i, -1, -1):
            if self.segments[j].ds > 0:
                return geo.bearing_deg(self.segments[j].p0, self.segments[j].p1)
        for seg in self.segments[i:]:
            if seg.ds > 0:
                return geo.bearing_deg(seg.p0, seg.p1)
        return 0.0

    def sample(self, interval_s: float = 1.0, start: float = 0.0, end: Optional[float] = None) -> list[TimelinePoint]:
        """Points every interval_s seconds from start to end (default: the end of the timeline;
        the end point is always included)."""
        if interval_s <= 0:
            raise ValueError("Sample interval must be positive")
        stop = self.duration if end is None else min(max(end, start), self.duration)
        out: list[TimelinePoint] = []
        n = int(math.floor((stop - start) / interval_s + 1e-9))
        for k in range(n + 1):
            out.append(self.at(start + k * interval_s))
        if not out or out[-1].t < stop - 1e-6:
            out.append(self.at(stop))
        return out

    def next_hold(self, t: float, direction: int = 1) -> Optional[tuple[float, int]]:
        """The first hold strictly after t (before t when going backwards)."""
        if direction > 0:
            return next(((h, i) for h, i in self.holds if h > t + 1e-9), None)
        return next(((h, i) for h, i in reversed(self.holds) if h < t - 1e-9), None)

    def summary(self) -> dict:
        return {
            "distance_m": round(self.distance, 1),
            "duration_s": round(self.duration, 1),
            "max_speed_kmh": round(self.max_speed * 3.6, 2),
            "avg_speed_kmh": round(self.distance / self.duration * 3.6, 2) if self.duration > 0 else 0.0,
            "waypoint_times_s": [round(t, 1) for t in self.waypoint_times],
            "moving_time_s": round(self.duration - self.dwell_total, 1),
            "corners_slowed": self.corners_slowed,
            "turns": len(self.turns),
            "sharpest_turn": _sharpest(self.turns),
            "holds": len(self.holds),
            "warnings": self.warnings,
        }


def build_timeline(waypoints: Sequence[Waypoint], legs: Sequence[Leg], settings: ProfileSettings) -> Timeline:
    """Solve the speed profile for a multi-leg route."""
    if len(waypoints) < 2:
        raise ValueError("A route needs at least two waypoints")
    if len(legs) != len(waypoints) - 1:
        raise ValueError("There must be exactly one leg between each pair of waypoints")
    if settings.accel_ms2 <= 0 or settings.decel_ms2 <= 0:
        raise ValueError("Acceleration and deceleration must be greater than 0")
    for i, wp in enumerate(waypoints):
        geo.validate_latlon(wp.lat, wp.lon)
        if wp.speed_kmh is not None and wp.speed_kmh < 0:
            raise ValueError(f"Waypoint {i + 1}: speed cannot be negative")
        if wp.dwell_s < 0:
            raise ValueError(f"Waypoint {i + 1}: wait time cannot be negative")

    cruises: list[float] = []
    for i, leg in enumerate(legs):
        c = settings.default_cruise_kmh if leg.cruise_kmh is None else leg.cruise_kmh
        if c <= 0:
            raise ValueError(f"Leg {i + 1}: cruise speed must be greater than 0")
        if leg.ramp not in ("accel", "linear"):
            raise ValueError(f"Leg {i + 1}: unknown ramp mode {leg.ramp!r}")
        cruises.append(c * KMH)

    # --- 1. densify every leg into nodes ---------------------------------------------------
    total_len = sum(geo.polyline_length(_leg_points(wp_a, wp_b, leg)) for wp_a, wp_b, leg in _legs_with_ends(waypoints, legs))
    step = max(settings.max_step_m, total_len / MAX_NODES)

    nodes: list[geo.LatLon] = []
    node_leg: list[int] = []  # leg index of the step that *starts* at this node
    wp_node: list[int] = []
    for i, (wa, wb, leg) in enumerate(_legs_with_ends(waypoints, legs)):
        pts = geo.densify(_leg_points(wa, wb, leg), step)
        if i == 0:
            wp_node.append(0)
            nodes.append(pts[0])
            node_leg.append(0)
        else:
            node_leg[-1] = i
        for p in pts[1:]:
            nodes.append(p)
            node_leg.append(i)
        wp_node.append(len(nodes) - 1)

    n = len(nodes)
    ds = [geo.haversine_m(nodes[k], nodes[k + 1]) for k in range(n - 1)]
    cum = [0.0]
    for d in ds:
        cum.append(cum[-1] + d)

    # --- 2. speed caps per node ---------------------------------------------------------------
    inf = float("inf")
    cap = [inf] * n
    step_cap = _step_caps(legs, cruises, node_leg, wp_node, cum, settings)
    for k in range(n - 1):  # each step limited by its leg's speed (both ends)
        c = step_cap[k]
        cap[k] = min(cap[k], c)
        cap[k + 1] = min(cap[k + 1], c)
    corners = 0
    turns: list[Turn] = []
    if settings.corner_slowdown:
        turns = apply_turn_caps(nodes, cum, cap, [legs[i].mode for i in node_leg], settings)
        corners = sum(1 for t in turns if t.slowed)

    pinned: dict[int, float] = {}
    for i, wp in enumerate(waypoints):
        k = wp_node[i]
        if wp.dwell_s > 0 or wp.hold:
            pinned[k] = 0.0
        elif wp.speed_kmh is not None:
            pinned[k] = wp.speed_kmh * KMH
        elif i == 0 and settings.start_from_rest:
            pinned[k] = 0.0
        elif i == len(waypoints) - 1 and settings.stop_at_end:
            pinned[k] = 0.0
    for k, v in pinned.items():
        cap[k] = v  # an explicit checkpoint may exceed the cruise limit on purpose

    # Per-step acceleration limits; linear-ramp legs follow their own curve instead.
    acc = [settings.accel_ms2] * (n - 1)
    dec = [settings.decel_ms2] * (n - 1)
    warnings: list[str] = []
    for i, leg in enumerate(legs):
        if leg.ramp != "linear":
            continue
        ka, kb = wp_node[i], wp_node[i + 1]
        # Unpinned ends take the cap already there (the lower of the adjacent cruise speeds).
        v0 = pinned.get(ka, cap[ka])
        v1 = pinned.get(kb, cap[kb])
        length = cum[kb] - cum[ka]
        if length <= 0:
            continue
        if v0 <= MIN_MOVING_SPEED and v1 <= MIN_MOVING_SPEED:
            raise ValueError(
                f"Leg {i + 1} uses a linear ramp but its speed is 0 at both ends, so it would never move. "
                "Give one end a speed or use the acceleration ramp."
            )
        for k in range(ka, kb + 1):
            f = (cum[k] - cum[ka]) / length
            cap[k] = math.sqrt(max(v0 * v0 + (v1 * v1 - v0 * v0) * f, 0.0))
        for k in range(ka, kb):
            acc[k] = inf
            dec[k] = inf

    # --- 3. forward / backward passes ------------------------------------------------------------
    v = cap[:]
    v[0] = min(v[0], cap[0])
    for k in range(n - 1):
        lim = math.sqrt(v[k] * v[k] + 2 * acc[k] * ds[k]) if acc[k] != inf else inf
        v[k + 1] = min(v[k + 1], lim)
    for k in range(n - 2, -1, -1):
        lim = math.sqrt(v[k + 1] * v[k + 1] + 2 * dec[k] * ds[k]) if dec[k] != inf else inf
        v[k] = min(v[k], lim)

    for k, want in pinned.items():
        if want - v[k] > 0.5 * KMH:
            wi = wp_node.index(k)
            warnings.append(
                f"Waypoint {wi + 1}: requested {want * 3.6:.1f} km/h but only {v[k] * 3.6:.1f} km/h is "
                "reachable with the current acceleration/deceleration. Raise them or move the waypoint."
            )

    # --- 4. integrate time ----------------------------------------------------------------------
    dwell_at = {wp_node[i]: wp.dwell_s for i, wp in enumerate(waypoints) if wp.dwell_s > 0}
    segments: list[Segment] = []
    t = 0.0
    node_arrival = [0.0] * n
    for k in range(n):
        node_arrival[k] = t
        d = dwell_at.get(k, 0.0)
        if d > 0:
            segments.append(Segment(t, t + d, nodes[k], nodes[k], 0.0, 0.0, 0.0, cum[k]))
            t += d
        if k == n - 1:
            break
        if ds[k] <= 0:
            continue
        vs = v[k] + v[k + 1]
        if vs < MIN_MOVING_SPEED:
            leg_i = node_leg[k]
            raise ValueError(
                f"Leg {leg_i + 1}: the speed drops to 0 and never recovers (two stops in a row with no "
                "speed in between). Give a waypoint between them a speed."
            )
        dt = 2 * ds[k] / vs
        segments.append(Segment(t, t + dt, nodes[k], nodes[k + 1], v[k], v[k + 1], ds[k], cum[k]))
        t += dt

    if not segments:  # all waypoints on the same spot and no dwell
        segments.append(Segment(0.0, 0.0, nodes[0], nodes[0], 0.0, 0.0, 0.0, 0.0))

    tl = Timeline(segments, [node_arrival[k] for k in wp_node], warnings)
    tl.dwell_total = sum(dwell_at.values())
    tl.corners_slowed = corners
    tl.turns = turns
    tl.holds = sorted((node_arrival[wp_node[i]], i) for i, wp in enumerate(waypoints) if wp.hold)
    return tl


def _step_caps(legs, cruises, node_leg, wp_node, cum, settings: ProfileSettings) -> list[float]:
    """Speed limit of every step: the leg's cruise speed, or in road-aware mode the road's
    typical speed from the routing data (times the driving-style factor)."""
    n_steps = len(cum) - 1
    out = [0.0] * n_steps
    for k in range(n_steps):
        li = node_leg[k]
        leg = legs[li]
        c = cruises[li]
        if settings.road_aware and leg.zones:
            s_mid = (cum[k] + cum[k + 1]) / 2 - cum[wp_node[li]]
            v = _zone_speed(leg.zones, s_mid)
            if v:
                road = v * settings.speed_factor
                # An explicit cruise speed on the leg still acts as the driver's own limit.
                c = min(road, c) if leg.cruise_kmh is not None else road
        out[k] = max(c, MIN_MOVING_SPEED * 2)
    return out


def _zone_speed(zones: list[tuple[float, Optional[float]]], s: float) -> Optional[float]:
    ends = [z[0] for z in zones]
    i = bisect.bisect_left(ends, s)
    if i >= len(zones):
        i = len(zones) - 1
    return zones[i][1]


# ---------------------------------------------------------------- cornering physics
G = 9.81


@dataclass(frozen=True)
class Vehicle:
    """What a vehicle can do in a turn.

    * a_lat_low, a_lat_high: the sideways (lateral) acceleration a driver is comfortable with at
      walking pace and at v_high m/s and above; it falls linearly in between, because people accept
      less sideways force the faster they go.
    * grip, safety: the tyre/road friction coefficient and the share of it a careful driver uses;
      a turn is never planned faster than sqrt(grip * safety * g * R).
    * min_radius: the tightest circle it can drive (a car's turning circle is about 11 m across), so
      a U-turn is planned at the speed of that circle.
    * cut_junction, cut_lane: how far (m) the line actually driven may stray inside the line the map
      draws. Maps draw a junction as a sharp corner on the road centre lines, and drivers round it
      using the junction's width (about 4 m for a car on a 50 km/h road); on a curve that is drawn
      as a curve they only have their lane (about 1 m). Junctions on faster roads are bigger, so
      cut_junction scales with the road speed relative to v_typical (0.6x to 2x).
    """

    a_lat_low: float
    a_lat_high: float
    v_high: float
    grip: float
    safety: float
    min_radius: float
    cut_junction: float
    cut_lane: float
    v_typical: float


VEHICLES = {
    "car": Vehicle(2.8, 1.8, 30.0, 0.7, 0.55, 5.5, 4.0, 1.0, 13.9),
    "bike": Vehicle(2.4, 2.0, 10.0, 0.6, 0.5, 2.5, 1.5, 0.5, 5.0),
    "foot": Vehicle(1.6, 1.6, 3.0, 0.6, 0.6, 0.5, 0.4, 0.2, 1.4),
    "sea": Vehicle(0.6, 0.4, 15.0, 1.0, 1.0, 40.0, 40.0, 15.0, 10.0),
}
JUNCTION_LEN = 8.0  # a bend drawn shorter than this many cut_junction lengths counts as a junction corner
TURN_MIN_DEG = 10.0  # gentler bends slow nobody down
TURN_NOISE_DEG = 0.3  # smaller heading changes at a node are digitising noise
TURN_WOBBLE_DEG = 4.0  # a small kink the other way inside a bend doesn't end it
TURN_GAP_S = 1.0  # a bend continues across straight bits shorter than this much travel time ...
TURN_GAP_MIN_M, TURN_GAP_MAX_M = 10.0, 40.0  # ... clamped to these lengths


@dataclass
class Turn:
    s: float  # distance along the route at the middle of the bend (m)
    angle_deg: float  # how far the heading turns; positive = to the right (clockwise)
    radius_m: float  # radius of the arc the vehicle drives
    speed_kmh: float  # speed it takes the bend at
    slowed: bool  # whether that is slower than the road or leg allows there


def vehicle_for(mode: str, cruise_ms: float) -> Optional[Vehicle]:
    """The vehicle whose limits apply on a leg. Straight legs guess it from the speed; very fast
    ones (trains, planes between far-apart checkpoints) are not slowed for their corners."""
    if mode in VEHICLES:
        return VEHICLES[mode]
    kmh = cruise_ms * 3.6
    if kmh <= 8:
        return VEHICLES["foot"]
    if kmh <= 30:
        return VEHICLES["bike"]
    if kmh <= 150:
        return VEHICLES["car"]
    return None


def turn_speed(veh: Vehicle, radius_m: float, a_scale: float = 1.0) -> float:
    """Fastest speed (m/s) at which the vehicle takes a turn of this radius comfortably and
    safely: v = sqrt(a_lat(v) * R), where a_lat falls linearly from a_lat_low (at rest) to
    a_lat_high (at v_high and above), capped by the grip limit."""
    r = max(radius_m, veh.min_radius)
    a0, a1 = veh.a_lat_low * a_scale, veh.a_lat_high * a_scale
    k = (a0 - a1) / veh.v_high
    # v^2 = (a0 - k v) R  ->  v^2 + kR v - a0 R = 0, valid while v <= v_high
    v = (-k * r + math.sqrt((k * r) ** 2 + 4 * a0 * r)) / 2
    if v > veh.v_high:
        v = math.sqrt(a1 * r)
    return min(v, math.sqrt(veh.grip * veh.safety * G * r))


def _bends(nodes, cum, gap_m) -> list[tuple[int, int, float]]:
    """Bends along the path as (first node, last node, signed heading change in degrees): runs of
    nodes where the heading keeps changing the same way, across straight bits up to gap_m(k)."""
    n = len(nodes)
    delta = [0.0] * n
    prev_b: Optional[float] = None
    for k in range(n - 1):
        if cum[k + 1] - cum[k] <= 0.05:
            continue
        b = geo.bearing_deg(nodes[k], nodes[k + 1])
        if prev_b is not None:
            delta[k] = (b - prev_b + 540.0) % 360.0 - 180.0
        prev_b = b
    out: list[tuple[int, int, float]] = []
    cur: Optional[list] = None  # [first, last, sum, sign]
    for k in range(1, n - 1):
        d = delta[k]
        if abs(d) < TURN_NOISE_DEG:
            continue
        sign = 1 if d > 0 else -1
        near = cur is not None and cum[k] - cum[cur[1]] <= gap_m(k)
        if near and (sign == cur[3] or abs(d) <= TURN_WOBBLE_DEG):
            cur[1], cur[2] = k, cur[2] + d
            continue
        if cur is not None:
            out.append((cur[0], cur[1], cur[2]))
        cur = [k, k, d, sign]
    if cur is not None:
        out.append((cur[0], cur[1], cur[2]))
    return out


def driven_radius(veh: Vehicle, theta_deg: float, length: float, v_ref: float, room: float) -> float:
    """Radius of the arc a driver follows through a bend of `theta_deg` drawn over `length` metres.

    The drawn bend has radius length / angle (0 for a sharp corner). The driver straightens it as far
    as the road lets them: an arc with the same entry and exit directions whose middle lies `e` metres
    inside the drawn line has radius r_drawn + e / (1 / cos(angle / 2) - 1). `e` blends from
    cut_junction (a corner drawn sharp) to cut_lane (a drawn curve); the arc must also fit into the
    straight road available either side (`room`), and is never tighter than the turning circle."""
    th = math.radians(min(theta_deg, 179.9))
    r_drawn = length / math.radians(theta_deg)
    junction = min(1.0, max(0.0, 1.0 - length / (JUNCTION_LEN * veh.cut_junction)))
    scale = min(2.0, max(0.6, v_ref / veh.v_typical))
    e = (veh.cut_lane + (veh.cut_junction - veh.cut_lane) * junction) * scale
    sec_1 = 1.0 / math.cos(th / 2) - 1.0
    r_cut = r_drawn + e / sec_1
    r_fit = (room + length / 2) / math.tan(th / 2)
    return max(veh.min_radius, r_drawn, min(r_cut, r_fit))


def apply_turn_caps(nodes, cum, cap, node_modes, settings: ProfileSettings) -> list[Turn]:
    """Find every bend and cap the speed through it at what its radius and the vehicle allow
    (see driven_radius and turn_speed). The limit covers the whole driven arc; the backward pass
    then brakes in time for it and the forward pass accelerates out of it at the configured rates."""
    n = len(nodes)
    if n < 3:
        return []
    ref = [c if math.isfinite(c) else 0.0 for c in cap]  # road / leg speeds before any bend
    gap = lambda k: min(TURN_GAP_MAX_M, max(TURN_GAP_MIN_M, TURN_GAP_S * ref[k]))  # noqa: E731
    bends = [b for b in _bends(nodes, cum, gap) if abs(b[2]) >= TURN_MIN_DEG]
    a_scale = settings.speed_factor ** 2 if settings.road_aware else 1.0
    total = cum[-1]
    floor = settings.min_corner_kmh / 3.6
    turns: list[Turn] = []
    for j, (k0, k1, ang) in enumerate(bends):
        v_ref = min(ref[k0:k1 + 1]) if k1 >= k0 else ref[k0]
        veh = vehicle_for(node_modes[k0], v_ref)
        if veh is None or v_ref <= 0:
            continue
        if settings.lateral_accel_ms2:
            a0 = settings.lateral_accel_ms2
            veh = replace(veh, a_lat_low=a0, a_lat_high=a0 * veh.a_lat_high / veh.a_lat_low)
        # straight road available before and after: up to halfway to the neighbouring bends
        before = cum[k0] - cum[bends[j - 1][1]] if j > 0 else cum[k0]
        after = cum[bends[j + 1][0]] - cum[k1] if j + 1 < len(bends) else total - cum[k1]
        room = max(0.0, min(before / 2 if j > 0 else before, after / 2 if j + 1 < len(bends) else after))
        theta = abs(ang)
        length = cum[k1] - cum[k0]
        radius = driven_radius(veh, theta, length, v_ref, room)
        v = max(turn_speed(veh, radius, a_scale), min(floor, v_ref))
        # the limit holds along the whole driven arc (at least the drawn bend)
        mid = (cum[k0] + cum[k1]) / 2
        half = max(length / 2, radius * math.radians(theta) / 2)
        lo = bisect.bisect_left(cum, mid - half)
        hi = bisect.bisect_right(cum, mid + half)
        slowed = False
        for k in range(lo, hi):
            if v < cap[k] - 1e-9:
                cap[k] = v
                slowed = True
        turns.append(Turn((cum[k0] + cum[k1]) / 2, round(ang, 1), round(radius, 1), round(min(v, v_ref) * 3.6, 1), slowed))
    return turns


def _sharpest(turns: list[Turn]) -> Optional[dict]:
    slowed = [t for t in turns if t.slowed]
    if not slowed:
        return None
    t = min(slowed, key=lambda x: x.speed_kmh)
    return {"angle_deg": abs(t.angle_deg), "radius_m": t.radius_m, "speed_kmh": t.speed_kmh, "distance_m": round(t.s, 1)}


def timeline_from_timed_points(points: Sequence[tuple[float, float, float]]) -> Timeline:
    """Timeline that follows (t_seconds, lat, lon) points exactly, constant speed between them."""
    if len(points) < 1:
        raise ValueError("No points")
    pts = sorted(points, key=lambda p: p[0])
    t_base = pts[0][0]
    segments: list[Segment] = []
    s0 = 0.0
    for (ta, la, oa), (tb, lb, ob) in zip(pts, pts[1:]):
        a, b = (la, oa), (lb, ob)
        d = geo.haversine_m(a, b)
        dur = tb - ta
        if dur <= 0:
            # Same timestamp: jump (rare in real files). Model as an instant move.
            segments.append(Segment(ta - t_base, ta - t_base, a, b, 0.0, 0.0, d, s0))
        else:
            sp = d / dur
            segments.append(Segment(ta - t_base, tb - t_base, a, b, sp, sp, d, s0))
        s0 += d
    if not segments:
        p = (pts[0][1], pts[0][2])
        segments.append(Segment(0.0, 0.0, p, p, 0.0, 0.0, 0.0, 0.0))
    return Timeline(segments)


def _legs_with_ends(waypoints: Sequence[Waypoint], legs: Sequence[Leg]):
    for i, leg in enumerate(legs):
        yield waypoints[i], waypoints[i + 1], leg


def _leg_points(wa: Waypoint, wb: Waypoint, leg: Leg) -> list[geo.LatLon]:
    """Leg geometry, guaranteed to start and end exactly at its waypoints."""
    a, b = (wa.lat, wa.lon), (wb.lat, wb.lon)
    pts = [tuple(p) for p in leg.points] if leg.points else []
    if not pts:
        return [a, b]
    if geo.haversine_m(pts[0], a) > 0.01:
        pts.insert(0, a)
    else:
        pts[0] = a
    if geo.haversine_m(pts[-1], b) > 0.01:
        pts.append(b)
    else:
        pts[-1] = b
    return pts  # type: ignore[return-value]


def build_matching_eta(
    waypoints: Sequence[Waypoint],
    legs: Sequence[Leg],
    settings: ProfileSettings,
    reference_moving_s: float,
    tolerance: float = 0.03,
    max_iter: int = 6,
    factor_range: tuple[float, float] = (0.6, 1.6),
) -> tuple[Timeline, float]:
    """Road-aware timeline whose moving time lands near a routing service's ETA.

    The ETA is a reference, not a target to hit exactly: the driving-style factor is tuned within
    factor_range, so a route that cannot plausibly match (e.g. heavy traffic in Google's ETA)
    stays at the nearest plausible speed. Returns the timeline and the factor used.
    """
    if reference_moving_s <= 0 or not settings.road_aware:
        return build_timeline(waypoints, legs, settings), settings.speed_factor

    lo, hi = factor_range
    factor = min(max(settings.speed_factor, lo), hi)
    tl = build_timeline(waypoints, legs, replace(settings, speed_factor=factor))
    for _ in range(max_iter):
        moving = tl.duration - tl.dwell_total
        if moving <= 0:
            break
        ratio = moving / reference_moving_s
        if abs(ratio - 1) <= tolerance:
            break
        new = min(max(factor * ratio, lo), hi)
        if abs(new - factor) < 1e-3:
            break
        factor = new
        tl = build_timeline(waypoints, legs, replace(settings, speed_factor=factor))
    return tl, factor
