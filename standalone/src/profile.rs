//! Speed-profile engine: turns a routed path plus speed checkpoints into a timeline with
//! uniform (constant) acceleration and deceleration between speeds.
//!
//! Same model as the browser version (profile.py): densify the path, cap the speed at every
//! node (leg cruise speed / road speed / checkpoint speed / bends), then a forward pass applies
//! the acceleration limit and a backward pass the deceleration limit. Inside each step the
//! acceleration is constant, so v^2 changes linearly with distance.

use crate::geo::{self, LatLon};
use serde::Serialize;

const KMH: f64 = 1.0 / 3.6;
const MIN_MOVING_SPEED: f64 = 0.05;
const MAX_NODES: f64 = 60_000.0;
// The heading while moving is the path's direction over a short window around the current spot
// (a car turns over several metres, not at a polyline vertex): about 0.8 s of travel.
const HEADING_WINDOW_S: f64 = 0.8;
const HEADING_WINDOW_MIN_M: f64 = 2.0;
const HEADING_WINDOW_MAX_M: f64 = 12.0;

#[derive(Clone, Debug)]
pub struct Waypoint {
    pub lat: f64,
    pub lon: f64,
    pub speed_kmh: Option<f64>,
    pub dwell_s: f64,
    /// Stop here and wait until the user presses Continue (then any dwell_s).
    pub hold: bool,
}

impl Waypoint {
    pub fn at(p: LatLon) -> Self {
        Self { lat: p.0, lon: p.1, speed_kmh: None, dwell_s: 0.0, hold: false }
    }
    fn ll(&self) -> LatLon {
        (self.lat, self.lon)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Ramp {
    Accel,
    Linear,
}

#[derive(Clone, Debug)]
pub struct Leg {
    pub points: Vec<LatLon>,
    pub cruise_kmh: Option<f64>,
    pub ramp: Ramp,
    /// Road-aware mode: typical speed (m/s) up to each distance along the leg.
    pub zones: Option<Vec<(f64, Option<f64>)>>,
    /// How the leg is travelled (car, bike, foot, sea, straight): picks the vehicle whose cornering
    /// limits apply. Straight legs guess the vehicle from their speed.
    pub mode: String,
}

impl Leg {
    pub fn new(points: Vec<LatLon>) -> Self {
        Self { points, cruise_kmh: None, ramp: Ramp::Accel, zones: None, mode: "straight".into() }
    }
}

#[derive(Clone, Debug)]
pub struct ProfileSettings {
    pub default_cruise_kmh: f64,
    pub accel_ms2: f64,
    pub decel_ms2: f64,
    pub start_from_rest: bool,
    pub stop_at_end: bool,
    pub max_step_m: f64,
    pub road_aware: bool,
    pub speed_factor: f64,
    /// Take every bend at the speed its radius and the vehicle allow.
    pub corner_slowdown: bool,
    /// Override of the vehicle's comfortable lateral acceleration at low speed (m/s²); None = the
    /// vehicle's own (see VEHICLES). Its fall-off at speed scales along.
    pub lateral_accel_ms2: Option<f64>,
    /// Optional floor for planned turn speeds.
    pub min_corner_kmh: f64,
}

impl Default for ProfileSettings {
    fn default() -> Self {
        Self {
            default_cruise_kmh: 5.0,
            accel_ms2: 1.0,
            decel_ms2: 1.0,
            start_from_rest: true,
            stop_at_end: true,
            max_step_m: 2.0,
            road_aware: false,
            speed_factor: 1.0,
            corner_slowdown: false,
            lateral_accel_ms2: None,
            min_corner_kmh: 0.0,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Segment {
    pub t0: f64,
    pub t1: f64,
    pub p0: LatLon,
    pub p1: LatLon,
    pub v0: f64,
    pub v1: f64,
    pub ds: f64,
    pub s0: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct TimelinePoint {
    pub t: f64,
    pub lat: f64,
    pub lon: f64,
    pub speed_ms: f64,
    pub course: f64,
    pub distance_m: f64,
}

#[derive(Clone, Debug, Default)]
pub struct Timeline {
    pub segments: Vec<Segment>,
    pub waypoint_times: Vec<f64>,
    pub warnings: Vec<String>,
    pub dwell_total: f64,
    pub corners_slowed: usize,
    /// every bend found (see apply_turn_caps)
    pub turns: Vec<Turn>,
    /// (time, waypoint index) of every "hold until Continue" checkpoint: the moment the device
    /// comes to a stop there, before any wait time.
    pub holds: Vec<(f64, usize)>,
    t0s: Vec<f64>,
    /// indexes of the moving segments and their start distances, for the heading window
    moving: Vec<usize>,
    s0s: Vec<f64>,
}

impl Timeline {
    pub fn new(segments: Vec<Segment>, waypoint_times: Vec<f64>, warnings: Vec<String>) -> Self {
        let t0s = segments.iter().map(|s| s.t0).collect();
        let moving: Vec<usize> = (0..segments.len()).filter(|&i| segments[i].ds > 0.0).collect();
        let s0s = moving.iter().map(|&i| segments[i].s0).collect();
        Self { segments, waypoint_times, warnings, dwell_total: 0.0, corners_slowed: 0, turns: Vec::new(), holds: Vec::new(), t0s, moving, s0s }
    }

    /// The first hold strictly after t (before t when going backwards).
    pub fn next_hold(&self, t: f64, forward: bool) -> Option<(f64, usize)> {
        if forward {
            self.holds.iter().copied().find(|h| h.0 > t + 1e-9)
        } else {
            self.holds.iter().rev().copied().find(|h| h.0 < t - 1e-9)
        }
    }

    /// Position at distance s (m) along the path, clamped to it.
    pub fn point_at_distance(&self, s: f64) -> Option<LatLon> {
        if self.moving.is_empty() {
            return None;
        }
        let s = s.clamp(0.0, self.distance());
        let i = match self.s0s.partition_point(|&x| x <= s) {
            0 => 0,
            n => n - 1,
        };
        let seg = &self.segments[self.moving[i]];
        Some(geo::interpolate(seg.p0, seg.p1, ((s - seg.s0) / seg.ds).clamp(0.0, 1.0)))
    }

    /// Direction of travel at distance s: the path's bearing over a short window, so the heading
    /// turns smoothly through corners instead of jumping at each polyline vertex. Standing still,
    /// the device faces the way it arrived (or, at the start, the way it leaves).
    pub fn heading_at(&self, s: f64, speed_ms: f64, moving: bool) -> Option<f64> {
        if self.moving.is_empty() {
            return None;
        }
        let w = (speed_ms * HEADING_WINDOW_S).clamp(HEADING_WINDOW_MIN_M, HEADING_WINDOW_MAX_M);
        let (a, b) = if moving {
            (s - w, s + w)
        } else if s - 2.0 * w >= 0.0 {
            (s - 2.0 * w, s)
        } else {
            (s, s + 2.0 * w)
        };
        let (a, b) = (a.max(0.0), b.min(self.distance()));
        if b - a < 0.5 {
            return None;
        }
        let (pa, pb) = (self.point_at_distance(a)?, self.point_at_distance(b)?);
        if geo::haversine_m(pa, pb) < 0.3 {
            return None;
        }
        Some(geo::bearing_deg(pa, pb))
    }

    pub fn duration(&self) -> f64 {
        self.segments.last().map(|s| s.t1).unwrap_or(0.0)
    }

    pub fn distance(&self) -> f64 {
        self.segments.last().map(|s| s.s0 + s.ds).unwrap_or(0.0)
    }

    pub fn max_speed(&self) -> f64 {
        self.segments.iter().map(|s| s.v0.max(s.v1)).fold(0.0, f64::max)
    }

    /// State at time t (clamped to the timeline).
    pub fn at(&self, t: f64) -> TimelinePoint {
        let t = t.clamp(0.0, self.duration());
        let i = match self.t0s.partition_point(|&x| x <= t) {
            0 => 0,
            n => n - 1,
        };
        let seg = &self.segments[i];
        let tau = t - seg.t0;
        let (s, v) = if seg.ds <= 0.0 || seg.t1 <= seg.t0 {
            (0.0, if seg.ds > 0.0 { seg.v0 } else { 0.0 })
        } else {
            let dur = seg.t1 - seg.t0;
            let a = (seg.v1 - seg.v0) / dur;
            let s = (seg.v0 * tau + 0.5 * a * tau * tau).clamp(0.0, seg.ds);
            (s, seg.v0 + a * tau)
        };
        let f = if seg.ds > 0.0 { s / seg.ds } else { 0.0 };
        let (lat, lon) = geo::interpolate(seg.p0, seg.p1, f);
        let v = v.max(0.0);
        let course = self.heading_at(seg.s0 + s, v, v > MIN_MOVING_SPEED).unwrap_or_else(|| {
            if seg.ds > 0.0 { geo::bearing_deg(seg.p0, seg.p1) } else { self.last_course(i) }
        });
        TimelinePoint { t, lat, lon, speed_ms: v, course, distance_m: seg.s0 + s }
    }

    fn last_course(&self, i: usize) -> f64 {
        for j in (0..=i).rev() {
            let s = &self.segments[j];
            if s.ds > 0.0 {
                return geo::bearing_deg(s.p0, s.p1);
            }
        }
        for s in &self.segments[i..] {
            if s.ds > 0.0 {
                return geo::bearing_deg(s.p0, s.p1);
            }
        }
        0.0
    }

    pub fn sample(&self, interval_s: f64, start: f64) -> Vec<TimelinePoint> {
        let interval_s = interval_s.max(1e-3);
        let dur = self.duration();
        let n = (((dur - start) / interval_s) + 1e-9).floor().max(0.0) as usize;
        let mut out: Vec<TimelinePoint> = (0..=n).map(|k| self.at(start + k as f64 * interval_s)).collect();
        if out.last().map(|p| p.t < dur - 1e-6).unwrap_or(true) {
            out.push(self.at(dur));
        }
        out
    }

    /// Holds as [time, waypoint index] pairs (for the status API).
    pub fn holds_json(&self) -> Vec<serde_json::Value> {
        self.holds.iter().map(|(t, i)| serde_json::json!([(t * 100.0).round() / 100.0, i])).collect()
    }

    pub fn summary(&self) -> serde_json::Value {
        let d = self.duration();
        serde_json::json!({
            "distance_m": round1(self.distance()),
            "duration_s": round1(d),
            "max_speed_kmh": (self.max_speed() * 3.6 * 100.0).round() / 100.0,
            "avg_speed_kmh": if d > 0.0 { (self.distance() / d * 3.6 * 100.0).round() / 100.0 } else { 0.0 },
            "waypoint_times_s": self.waypoint_times.iter().map(|t| round1(*t)).collect::<Vec<_>>(),
            "moving_time_s": round1(d - self.dwell_total),
            "corners_slowed": self.corners_slowed,
            "turns": self.turns.len(),
            "sharpest_turn": sharpest(&self.turns),
            "holds": self.holds.len(),
            "warnings": self.warnings,
        })
    }
}

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

fn leg_points(wa: &Waypoint, wb: &Waypoint, leg: &Leg) -> Vec<LatLon> {
    let (a, b) = (wa.ll(), wb.ll());
    if leg.points.is_empty() {
        return vec![a, b];
    }
    let mut pts = leg.points.clone();
    if geo::haversine_m(pts[0], a) > 0.01 {
        pts.insert(0, a);
    } else {
        pts[0] = a;
    }
    let last = pts.len() - 1;
    if geo::haversine_m(pts[last], b) > 0.01 {
        pts.push(b);
    } else {
        pts[last] = b;
    }
    pts
}

fn zone_speed(zones: &[(f64, Option<f64>)], s: f64) -> Option<f64> {
    if zones.is_empty() {
        return None;
    }
    let i = zones.partition_point(|z| z.0 < s).min(zones.len() - 1);
    zones[i].1
}

pub fn build_timeline(waypoints: &[Waypoint], legs: &[Leg], settings: &ProfileSettings) -> Result<Timeline, String> {
    if waypoints.len() < 2 {
        return Err("A route needs at least two waypoints".into());
    }
    if legs.len() != waypoints.len() - 1 {
        return Err("There must be exactly one leg between each pair of waypoints".into());
    }
    if settings.accel_ms2 <= 0.0 || settings.decel_ms2 <= 0.0 {
        return Err("Acceleration and deceleration must be greater than 0".into());
    }
    for (i, wp) in waypoints.iter().enumerate() {
        geo::validate_latlon(wp.lat, wp.lon)?;
        if wp.speed_kmh.map(|v| v < 0.0).unwrap_or(false) {
            return Err(format!("Waypoint {}: speed cannot be negative", i + 1));
        }
        if wp.dwell_s < 0.0 {
            return Err(format!("Waypoint {}: wait time cannot be negative", i + 1));
        }
    }
    let mut cruises = Vec::with_capacity(legs.len());
    for (i, leg) in legs.iter().enumerate() {
        let c = leg.cruise_kmh.unwrap_or(settings.default_cruise_kmh);
        if c <= 0.0 {
            return Err(format!("Leg {}: cruise speed must be greater than 0", i + 1));
        }
        cruises.push(c * KMH);
    }

    // 1. densify
    let leg_pts: Vec<Vec<LatLon>> = legs
        .iter()
        .enumerate()
        .map(|(i, leg)| leg_points(&waypoints[i], &waypoints[i + 1], leg))
        .collect();
    let total_len: f64 = leg_pts.iter().map(|p| geo::polyline_length(p)).sum();
    let step = settings.max_step_m.max(total_len / MAX_NODES);
    let mut nodes: Vec<LatLon> = Vec::new();
    let mut node_leg: Vec<usize> = Vec::new();
    let mut wp_node: Vec<usize> = Vec::new();
    for (i, pts) in leg_pts.iter().enumerate() {
        let d = geo::densify(pts, step);
        if i == 0 {
            wp_node.push(0);
            nodes.push(d[0]);
            node_leg.push(0);
        } else {
            *node_leg.last_mut().unwrap() = i;
        }
        for p in &d[1..] {
            nodes.push(*p);
            node_leg.push(i);
        }
        wp_node.push(nodes.len() - 1);
    }
    let n = nodes.len();
    let ds: Vec<f64> = nodes.windows(2).map(|w| geo::haversine_m(w[0], w[1])).collect();
    let mut cum = vec![0.0; n];
    for k in 1..n {
        cum[k] = cum[k - 1] + ds[k - 1];
    }

    // 2. caps
    let inf = f64::INFINITY;
    let mut cap = vec![inf; n];
    for k in 0..n.saturating_sub(1) {
        let li = node_leg[k];
        let leg = &legs[li];
        let mut c = cruises[li];
        if settings.road_aware {
            if let Some(z) = &leg.zones {
                let s_mid = (cum[k] + cum[k + 1]) / 2.0 - cum[wp_node[li]];
                if let Some(v) = zone_speed(z, s_mid) {
                    let road = v * settings.speed_factor;
                    c = if leg.cruise_kmh.is_some() { road.min(c) } else { road };
                }
            }
        }
        let c = c.max(MIN_MOVING_SPEED * 2.0);
        cap[k] = cap[k].min(c);
        cap[k + 1] = cap[k + 1].min(c);
    }
    let turns = if settings.corner_slowdown {
        let modes: Vec<&str> = node_leg.iter().map(|&i| legs[i].mode.as_str()).collect();
        apply_turn_caps(&nodes, &cum, &mut cap, &modes, settings)
    } else {
        Vec::new()
    };
    let corners = turns.iter().filter(|t| t.slowed).count();

    let mut pinned: Vec<(usize, f64)> = Vec::new();
    for (i, wp) in waypoints.iter().enumerate() {
        let k = wp_node[i];
        let v = if wp.dwell_s > 0.0 || wp.hold {
            Some(0.0)
        } else if let Some(s) = wp.speed_kmh {
            Some(s * KMH)
        } else if (i == 0 && settings.start_from_rest) || (i == waypoints.len() - 1 && settings.stop_at_end) {
            Some(0.0)
        } else {
            None
        };
        if let Some(v) = v {
            pinned.retain(|(kk, _)| *kk != k);
            pinned.push((k, v));
        }
    }
    for &(k, v) in &pinned {
        cap[k] = v;
    }
    let pinned_get = |k: usize| pinned.iter().find(|(kk, _)| *kk == k).map(|(_, v)| *v);

    let mut acc = vec![settings.accel_ms2; n.saturating_sub(1)];
    let mut dec = vec![settings.decel_ms2; n.saturating_sub(1)];
    for (i, leg) in legs.iter().enumerate() {
        if leg.ramp != Ramp::Linear {
            continue;
        }
        let (ka, kb) = (wp_node[i], wp_node[i + 1]);
        let v0 = pinned_get(ka).unwrap_or(cap[ka]);
        let v1 = pinned_get(kb).unwrap_or(cap[kb]);
        let length = cum[kb] - cum[ka];
        if length <= 0.0 {
            continue;
        }
        if v0 <= MIN_MOVING_SPEED && v1 <= MIN_MOVING_SPEED {
            return Err(format!(
                "Leg {} uses a linear ramp but its speed is 0 at both ends, so it would never move. \
                 Give one end a speed or use the acceleration ramp.",
                i + 1
            ));
        }
        for k in ka..=kb {
            let f = (cum[k] - cum[ka]) / length;
            cap[k] = (v0 * v0 + (v1 * v1 - v0 * v0) * f).max(0.0).sqrt();
        }
        for k in ka..kb {
            acc[k] = inf;
            dec[k] = inf;
        }
    }

    // 3. forward / backward passes
    let mut v = cap.clone();
    for k in 0..n.saturating_sub(1) {
        let lim = if acc[k].is_finite() { (v[k] * v[k] + 2.0 * acc[k] * ds[k]).sqrt() } else { inf };
        v[k + 1] = v[k + 1].min(lim);
    }
    for k in (0..n.saturating_sub(1)).rev() {
        let lim = if dec[k].is_finite() { (v[k + 1] * v[k + 1] + 2.0 * dec[k] * ds[k]).sqrt() } else { inf };
        v[k] = v[k].min(lim);
    }
    let mut warnings = Vec::new();
    for &(k, want) in &pinned {
        if want - v[k] > 0.5 * KMH {
            let wi = wp_node.iter().position(|&x| x == k).unwrap_or(0);
            warnings.push(format!(
                "Waypoint {}: requested {:.1} km/h but only {:.1} km/h is reachable with the current \
                 acceleration/deceleration. Raise them or move the waypoint.",
                wi + 1,
                want * 3.6,
                v[k] * 3.6
            ));
        }
    }

    // 4. integrate time
    let mut dwell_at = vec![0.0; n];
    for (i, wp) in waypoints.iter().enumerate() {
        if wp.dwell_s > 0.0 {
            dwell_at[wp_node[i]] = wp.dwell_s;
        }
    }
    let mut segments = Vec::new();
    let mut t = 0.0;
    let mut node_arrival = vec![0.0; n];
    for k in 0..n {
        node_arrival[k] = t;
        let d = dwell_at[k];
        if d > 0.0 {
            segments.push(Segment { t0: t, t1: t + d, p0: nodes[k], p1: nodes[k], v0: 0.0, v1: 0.0, ds: 0.0, s0: cum[k] });
            t += d;
        }
        if k == n - 1 {
            break;
        }
        if ds[k] <= 0.0 {
            continue;
        }
        let vs = v[k] + v[k + 1];
        if vs < MIN_MOVING_SPEED {
            return Err(format!(
                "Leg {}: the speed drops to 0 and never recovers (two stops in a row with no speed in between). \
                 Give a waypoint between them a speed.",
                node_leg[k] + 1
            ));
        }
        let dt = 2.0 * ds[k] / vs;
        segments.push(Segment { t0: t, t1: t + dt, p0: nodes[k], p1: nodes[k + 1], v0: v[k], v1: v[k + 1], ds: ds[k], s0: cum[k] });
        t += dt;
    }
    if segments.is_empty() {
        segments.push(Segment { t0: 0.0, t1: 0.0, p0: nodes[0], p1: nodes[0], v0: 0.0, v1: 0.0, ds: 0.0, s0: 0.0 });
    }
    let mut tl = Timeline::new(segments, wp_node.iter().map(|&k| node_arrival[k]).collect(), warnings);
    tl.dwell_total = dwell_at.iter().sum();
    tl.corners_slowed = corners;
    tl.turns = turns;
    tl.holds = waypoints.iter().enumerate().filter(|(_, w)| w.hold).map(|(i, _)| (node_arrival[wp_node[i]], i)).collect();
    tl.holds.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    Ok(tl)
}

// ---------------------------------------------------------------- cornering physics (same model as profile.py)
const G: f64 = 9.81;

/// What a vehicle can do in a turn (see profile.py for the meaning of each value).
/// * a_lat_low / a_lat_high: comfortable sideways acceleration at walking pace and at v_high m/s and
///   above, falling linearly in between;
/// * grip × safety: share of the tyre friction a careful driver uses (the turn speed never exceeds
///   sqrt(grip · safety · g · R));
/// * min_radius: tightest circle it can drive (a U-turn is planned on it);
/// * cut_junction / cut_lane: how far the driven line may stray inside the drawn one at a junction
///   drawn as a sharp corner / on a curve drawn as a curve; junctions scale with road speed / v_typical.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Vehicle {
    pub a_lat_low: f64,
    pub a_lat_high: f64,
    pub v_high: f64,
    pub grip: f64,
    pub safety: f64,
    pub min_radius: f64,
    pub cut_junction: f64,
    pub cut_lane: f64,
    pub v_typical: f64,
}

pub const CAR: Vehicle = Vehicle { a_lat_low: 2.8, a_lat_high: 1.8, v_high: 30.0, grip: 0.7, safety: 0.55, min_radius: 5.5, cut_junction: 4.0, cut_lane: 1.0, v_typical: 13.9 };
pub const BIKE: Vehicle = Vehicle { a_lat_low: 2.4, a_lat_high: 2.0, v_high: 10.0, grip: 0.6, safety: 0.5, min_radius: 2.5, cut_junction: 1.5, cut_lane: 0.5, v_typical: 5.0 };
pub const FOOT: Vehicle = Vehicle { a_lat_low: 1.6, a_lat_high: 1.6, v_high: 3.0, grip: 0.6, safety: 0.6, min_radius: 0.5, cut_junction: 0.4, cut_lane: 0.2, v_typical: 1.4 };
pub const SEA: Vehicle = Vehicle { a_lat_low: 0.6, a_lat_high: 0.4, v_high: 15.0, grip: 1.0, safety: 1.0, min_radius: 40.0, cut_junction: 40.0, cut_lane: 15.0, v_typical: 10.0 };
const JUNCTION_LEN: f64 = 8.0; // a bend drawn shorter than this many cut_junction lengths counts as a junction
const TURN_MIN_DEG: f64 = 10.0; // gentler bends slow nobody down
const TURN_NOISE_DEG: f64 = 0.3; // smaller heading changes at a node are digitising noise
const TURN_WOBBLE_DEG: f64 = 4.0; // a small kink the other way inside a bend doesn't end it
const TURN_GAP_S: f64 = 1.0; // a bend continues across straight bits shorter than this much travel ...
const TURN_GAP_MIN_M: f64 = 10.0;
const TURN_GAP_MAX_M: f64 = 40.0; // ... clamped to these lengths

#[derive(Clone, Debug, PartialEq)]
pub struct Turn {
    /// distance along the route at the middle of the bend (m)
    pub s: f64,
    /// how far the heading turns; positive = to the right (clockwise)
    pub angle_deg: f64,
    /// radius of the arc the vehicle drives
    pub radius_m: f64,
    /// speed it takes the bend at
    pub speed_kmh: f64,
    /// whether that is slower than the road or leg allows there
    pub slowed: bool,
}

/// The vehicle whose limits apply on a leg. Straight legs guess it from the speed; very fast ones
/// (trains, planes between far-apart checkpoints) are not slowed for their corners.
pub fn vehicle_for(mode: &str, cruise_ms: f64) -> Option<Vehicle> {
    match mode {
        "car" => Some(CAR),
        "bike" => Some(BIKE),
        "foot" => Some(FOOT),
        "sea" => Some(SEA),
        _ => {
            let kmh = cruise_ms * 3.6;
            if kmh <= 8.0 {
                Some(FOOT)
            } else if kmh <= 30.0 {
                Some(BIKE)
            } else if kmh <= 150.0 {
                Some(CAR)
            } else {
                None
            }
        }
    }
}

/// Fastest speed (m/s) at which the vehicle takes a turn of this radius comfortably and safely:
/// v = sqrt(a_lat(v) · R), a_lat falling linearly from a_lat_low to a_lat_high at v_high, capped by grip.
pub fn turn_speed(veh: &Vehicle, radius_m: f64, a_scale: f64) -> f64 {
    let r = radius_m.max(veh.min_radius);
    let (a0, a1) = (veh.a_lat_low * a_scale, veh.a_lat_high * a_scale);
    let k = (a0 - a1) / veh.v_high;
    // v² = (a0 - k v) R  ->  v² + kR v - a0 R = 0, valid while v <= v_high
    let mut v = (-k * r + ((k * r).powi(2) + 4.0 * a0 * r).sqrt()) / 2.0;
    if v > veh.v_high {
        v = (a1 * r).sqrt();
    }
    v.min((veh.grip * veh.safety * G * r).sqrt())
}

/// Radius of the arc driven through a bend of `theta_deg` drawn over `length` m: the drawn radius,
/// straightened by up to `e` m inside the drawn line (cut_junction for a corner drawn sharp, blending to
/// cut_lane for a drawn curve), fitted into the straight road available either side (`room`), and never
/// tighter than the turning circle.
pub fn driven_radius(veh: &Vehicle, theta_deg: f64, length: f64, v_ref: f64, room: f64) -> f64 {
    let th = theta_deg.min(179.9).to_radians();
    let r_drawn = length / theta_deg.to_radians();
    let junction = (1.0 - length / (JUNCTION_LEN * veh.cut_junction)).clamp(0.0, 1.0);
    let scale = (v_ref / veh.v_typical).clamp(0.6, 2.0);
    let e = (veh.cut_lane + (veh.cut_junction - veh.cut_lane) * junction) * scale;
    let sec_1 = 1.0 / (th / 2.0).cos() - 1.0;
    let r_cut = r_drawn + e / sec_1;
    let r_fit = (room + length / 2.0) / (th / 2.0).tan();
    veh.min_radius.max(r_drawn).max(r_cut.min(r_fit))
}

/// Bends along the path as (first node, last node, signed heading change in degrees).
fn bends(nodes: &[LatLon], cum: &[f64], gap_m: &dyn Fn(usize) -> f64) -> Vec<(usize, usize, f64)> {
    let n = nodes.len();
    let mut delta = vec![0.0; n];
    let mut prev_b: Option<f64> = None;
    for k in 0..n.saturating_sub(1) {
        if cum[k + 1] - cum[k] <= 0.05 {
            continue;
        }
        let b = geo::bearing_deg(nodes[k], nodes[k + 1]);
        if let Some(p) = prev_b {
            delta[k] = (b - p + 540.0).rem_euclid(360.0) - 180.0;
        }
        prev_b = Some(b);
    }
    let mut out = Vec::new();
    let mut cur: Option<(usize, usize, f64, f64)> = None; // first, last, sum, sign
    for k in 1..n.saturating_sub(1) {
        let d = delta[k];
        if d.abs() < TURN_NOISE_DEG {
            continue;
        }
        let sign = if d > 0.0 { 1.0 } else { -1.0 };
        if let Some(c) = cur.as_mut() {
            if cum[k] - cum[c.1] <= gap_m(k) && (sign == c.3 || d.abs() <= TURN_WOBBLE_DEG) {
                c.1 = k;
                c.2 += d;
                continue;
            }
            out.push((c.0, c.1, c.2));
        }
        cur = Some((k, k, d, sign));
    }
    if let Some(c) = cur {
        out.push((c.0, c.1, c.2));
    }
    out
}

/// Find every bend and cap the speed through its driven arc at what its radius and the vehicle allow.
/// The backward pass then brakes in time for it, the forward pass accelerates out of it.
fn apply_turn_caps(nodes: &[LatLon], cum: &[f64], cap: &mut [f64], modes: &[&str], s: &ProfileSettings) -> Vec<Turn> {
    let n = nodes.len();
    if n < 3 {
        return Vec::new();
    }
    let reference: Vec<f64> = cap.iter().map(|c| if c.is_finite() { *c } else { 0.0 }).collect();
    let gap = |k: usize| (TURN_GAP_S * reference[k]).clamp(TURN_GAP_MIN_M, TURN_GAP_MAX_M);
    let found: Vec<(usize, usize, f64)> = bends(nodes, cum, &gap).into_iter().filter(|b| b.2.abs() >= TURN_MIN_DEG).collect();
    let a_scale = if s.road_aware { s.speed_factor * s.speed_factor } else { 1.0 };
    let total = *cum.last().unwrap();
    let floor = s.min_corner_kmh / 3.6;
    let mut turns = Vec::new();
    for (j, &(k0, k1, ang)) in found.iter().enumerate() {
        let v_ref = reference[k0..=k1].iter().cloned().fold(f64::INFINITY, f64::min);
        let Some(mut veh) = vehicle_for(modes[k0], v_ref) else { continue };
        if v_ref <= 0.0 {
            continue;
        }
        if let Some(a0) = s.lateral_accel_ms2.filter(|a| *a > 0.0) {
            veh.a_lat_high = a0 * veh.a_lat_high / veh.a_lat_low;
            veh.a_lat_low = a0;
        }
        // straight road available before and after: up to halfway to the neighbouring bends
        let before = if j > 0 { (cum[k0] - cum[found[j - 1].1]) / 2.0 } else { cum[k0] };
        let after = if j + 1 < found.len() { (cum[found[j + 1].0] - cum[k1]) / 2.0 } else { total - cum[k1] };
        let room = before.min(after).max(0.0);
        let theta = ang.abs();
        let length = cum[k1] - cum[k0];
        let radius = driven_radius(&veh, theta, length, v_ref, room);
        let v = turn_speed(&veh, radius, a_scale).max(floor.min(v_ref));
        // the limit holds along the whole driven arc (at least the drawn bend)
        let mid = (cum[k0] + cum[k1]) / 2.0;
        let half = (length / 2.0).max(radius * theta.to_radians() / 2.0);
        let lo = cum.partition_point(|&x| x < mid - half);
        let hi = cum.partition_point(|&x| x <= mid + half);
        let mut slowed = false;
        for c in cap.iter_mut().take(hi).skip(lo) {
            if v < *c - 1e-9 {
                *c = v;
                slowed = true;
            }
        }
        turns.push(Turn {
            s: mid,
            angle_deg: (ang * 10.0).round() / 10.0,
            radius_m: (radius * 10.0).round() / 10.0,
            speed_kmh: (v.min(v_ref) * 3.6 * 10.0).round() / 10.0,
            slowed,
        });
    }
    turns
}

fn sharpest(turns: &[Turn]) -> serde_json::Value {
    match turns.iter().filter(|t| t.slowed).min_by(|a, b| a.speed_kmh.partial_cmp(&b.speed_kmh).unwrap_or(std::cmp::Ordering::Equal)) {
        Some(t) => serde_json::json!({"angle_deg": t.angle_deg.abs(), "radius_m": t.radius_m, "speed_kmh": t.speed_kmh, "distance_m": round1(t.s)}),
        None => serde_json::Value::Null,
    }
}

/// Road-aware timeline whose moving time lands near a routing service's ETA (a reference,
/// not an exact target: the driving-style factor stays within `range`).
pub fn build_matching_eta(
    waypoints: &[Waypoint],
    legs: &[Leg],
    settings: &ProfileSettings,
    reference_moving_s: f64,
) -> Result<(Timeline, f64), String> {
    if reference_moving_s <= 0.0 || !settings.road_aware {
        return Ok((build_timeline(waypoints, legs, settings)?, settings.speed_factor));
    }
    let (lo, hi) = (0.6, 1.6);
    let mut s = settings.clone();
    s.speed_factor = s.speed_factor.clamp(lo, hi);
    let mut tl = build_timeline(waypoints, legs, &s)?;
    for _ in 0..6 {
        let moving = tl.duration() - tl.dwell_total;
        if moving <= 0.0 {
            break;
        }
        let ratio = moving / reference_moving_s;
        if (ratio - 1.0).abs() <= 0.03 {
            break;
        }
        let new = (s.speed_factor * ratio).clamp(lo, hi);
        if (new - s.speed_factor).abs() < 1e-3 {
            break;
        }
        s.speed_factor = new;
        tl = build_timeline(waypoints, legs, &s)?;
    }
    Ok((tl, s.speed_factor))
}

/// Timeline that follows (t, lat, lon) points exactly, constant speed between them.
pub fn timeline_from_timed_points(points: &[(f64, f64, f64)]) -> Result<Timeline, String> {
    if points.is_empty() {
        return Err("No points".into());
    }
    let mut pts = points.to_vec();
    pts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let base = pts[0].0;
    let mut segs = Vec::new();
    let mut s0 = 0.0;
    for w in pts.windows(2) {
        let (a, b) = ((w[0].1, w[0].2), (w[1].1, w[1].2));
        let d = geo::haversine_m(a, b);
        let dur = w[1].0 - w[0].0;
        if dur <= 0.0 {
            segs.push(Segment { t0: w[0].0 - base, t1: w[0].0 - base, p0: a, p1: b, v0: 0.0, v1: 0.0, ds: d, s0 });
        } else {
            let sp = d / dur;
            segs.push(Segment { t0: w[0].0 - base, t1: w[1].0 - base, p0: a, p1: b, v0: sp, v1: sp, ds: d, s0 });
        }
        s0 += d;
    }
    if segs.is_empty() {
        let p = (pts[0].1, pts[0].2);
        segs.push(Segment { t0: 0.0, t1: 0.0, p0: p, p1: p, v0: 0.0, v1: 0.0, ds: 0.0, s0: 0.0 });
    }
    Ok(Timeline::new(segs, vec![], vec![]))
}

#[cfg(test)]
mod tests {
    use super::*;
    const A: LatLon = (51.5, -0.12);

    fn straight(dist: f64) -> (Vec<Waypoint>, Vec<Leg>) {
        let b = geo::destination(A, 90.0, dist);
        (vec![Waypoint::at(A), Waypoint::at(b)], vec![Leg::new(vec![A, b])])
    }

    #[test]
    fn trapezoid_matches_closed_form() {
        let (w, mut l) = straight(1000.0);
        l[0].cruise_kmh = Some(36.0);
        let s = ProfileSettings { accel_ms2: 1.0, decel_ms2: 2.0, ..Default::default() };
        let tl = build_timeline(&w, &l, &s).unwrap();
        assert!((tl.duration() - 107.5).abs() < 0.05, "{}", tl.duration());
        assert!((tl.at(5.0).speed_ms - 5.0).abs() < 0.05);
        assert!((tl.at(50.0).speed_ms - 10.0).abs() < 1e-6);
    }

    #[test]
    fn linear_ramp() {
        let (mut w, mut l) = straight(1000.0);
        w[0].speed_kmh = Some(0.0);
        w[1].speed_kmh = Some(72.0);
        l[0].ramp = Ramp::Linear;
        let s = ProfileSettings { stop_at_end: false, ..Default::default() };
        let tl = build_timeline(&w, &l, &s).unwrap();
        assert!((tl.duration() - 100.0).abs() < 0.5);
        assert!((tl.at(37.0).speed_ms - 7.4).abs() < 0.06);
    }

    #[test]
    fn dwell_and_corners_and_zones() {
        let far = geo::destination(A, 90.0, 500.0);
        let back = geo::destination(far, 270.0, 500.0);
        let w = vec![Waypoint::at(A), Waypoint::at(back)];
        let mut leg = Leg::new(vec![A, far, back]);
        leg.cruise_kmh = Some(50.0);
        let plain = build_timeline(&w, &[leg.clone()], &ProfileSettings { accel_ms2: 2.0, decel_ms2: 2.0, ..Default::default() }).unwrap();
        let slowed = build_timeline(
            &w,
            &[leg],
            &ProfileSettings { accel_ms2: 2.0, decel_ms2: 2.0, corner_slowdown: true, ..Default::default() },
        )
        .unwrap();
        assert!(slowed.duration() > plain.duration());
        assert_eq!(slowed.corners_slowed, 1);

        let b = geo::destination(A, 90.0, 2000.0);
        let mut leg = Leg::new(vec![A, b]);
        leg.zones = Some(vec![(1000.0, Some(10.0)), (2000.0, Some(25.0))]);
        let s = ProfileSettings { road_aware: true, accel_ms2: 3.0, decel_ms2: 3.0, ..Default::default() };
        let tl = build_timeline(&[Waypoint::at(A), Waypoint::at(b)], &[leg.clone()], &s).unwrap();
        assert!((tl.max_speed() - 25.0).abs() < 0.3);
        let target = tl.duration() * 1.25;
        let (tl2, f) = build_matching_eta(&[Waypoint::at(A), Waypoint::at(b)], &[leg], &s, target).unwrap();
        assert!(f < 1.0 && ((tl2.duration() - target) / target).abs() < 0.04);
    }

    fn corner(hold_at: Option<usize>, dwell: f64) -> Timeline {
        let b = geo::destination(A, 90.0, 200.0);
        let c = geo::destination(b, 0.0, 200.0);
        let mut w = vec![Waypoint::at(A), Waypoint::at(b), Waypoint::at(c)];
        if let Some(i) = hold_at {
            w[i].hold = true;
        }
        w[1].dwell_s = dwell;
        let s = ProfileSettings { default_cruise_kmh: 36.0, accel_ms2: 2.0, decel_ms2: 2.0, ..Default::default() };
        build_timeline(&w, &[Leg::new(vec![A, b]), Leg::new(vec![b, c])], &s).unwrap()
    }

    #[test]
    fn hold_checkpoint_stops_there() {
        let tl = corner(Some(1), 0.0);
        assert_eq!(tl.holds.len(), 1);
        let (h, i) = tl.holds[0];
        assert_eq!(i, 1);
        assert!((h - tl.waypoint_times[1]).abs() < 1e-9);
        let p = tl.at(h);
        assert!(p.speed_ms.abs() < 1e-6);
        assert!(geo::haversine_m((p.lat, p.lon), geo::destination(A, 90.0, 200.0)) < 0.05);
        assert!((p.course - 90.0).abs() < 1.0, "stopped: faces the way it arrived, got {}", p.course);
        assert_eq!(tl.next_hold(0.0, true), Some((h, 1)));
        assert_eq!(tl.next_hold(h, true), None);
        assert_eq!(tl.next_hold(h + 1.0, false), Some((h, 1)));
        assert_eq!(tl.summary()["holds"], 1);
        let tl2 = corner(Some(1), 10.0); // the wait runs after the hold
        assert!((tl2.holds[0].0 - tl2.waypoint_times[1]).abs() < 1e-9);
        assert_eq!(tl2.at(tl2.holds[0].0 + 5.0).speed_ms, 0.0);
    }

    #[test]
    fn heading_turns_smoothly_through_a_corner() {
        let tl = corner(None, 0.0);
        let tb = tl.waypoint_times[1];
        let p = tl.at(tb);
        assert!(p.speed_ms > 5.0 && p.course > 20.0 && p.course < 70.0, "{p:?}");
        assert!((tl.at(tb * 0.5).course - 90.0).abs() < 0.5);
        assert!((tl.at((tb + tl.duration()) / 2.0).course - 0.0).abs() < 0.5);
        let c: Vec<f64> = [-1.0, -0.5, 0.0, 0.5, 1.0].iter().map(|dt| tl.at(tb + dt).course).collect();
        let d: Vec<f64> = c.windows(2).map(|w| ((w[1] - w[0] + 540.0).rem_euclid(360.0) - 180.0).abs()).collect();
        assert!(d.iter().cloned().fold(0.0, f64::max) < 60.0);
        assert!((d.iter().sum::<f64>() - 90.0).abs() < 3.0);
        assert!((tl.at(0.0).course - 90.0).abs() < 0.5); // at the start: the way it leaves
    }

    fn junction(angle: f64, cruise: f64, mode: &str, len: f64) -> (Timeline, LatLon) {
        let corner = geo::destination(A, 90.0, len);
        let end = geo::destination(corner, 90.0 + angle, len);
        let mut leg = Leg::new(vec![A, corner, end]);
        leg.cruise_kmh = Some(cruise);
        leg.mode = mode.into();
        let s = ProfileSettings { accel_ms2: 2.0, decel_ms2: 2.0, corner_slowdown: true, ..Default::default() };
        (build_timeline(&[Waypoint::at(A), Waypoint::at(end)], &[leg], &s).unwrap(), corner)
    }

    fn min_speed_near(tl: &Timeline, p: LatLon, within: f64) -> f64 {
        tl.sample(0.25, 0.0).iter().filter(|q| geo::haversine_m((q.lat, q.lon), p) < within).map(|q| q.speed_ms).fold(f64::INFINITY, f64::min) * 3.6
    }

    #[test]
    fn turn_speed_follows_radius_and_vehicle() {
        let kmh = |v: f64| v * 3.6;
        assert!((15.0..22.0).contains(&kmh(turn_speed(&CAR, 9.7, 1.0))));
        assert!((11.0..16.0).contains(&kmh(turn_speed(&CAR, 0.0, 1.0)))); // U-turn on the turning circle
        assert!((19.0..27.0).contains(&kmh(turn_speed(&CAR, 15.0, 1.0)))); // roundabout
        assert!((78.0..92.0).contains(&kmh(turn_speed(&CAR, 300.0, 1.0)))); // motorway curve
        assert!(kmh(turn_speed(&CAR, 600.0, 1.0)) > 115.0);
        assert!((7.0..12.0).contains(&kmh(turn_speed(&BIKE, 3.0, 1.0))));
        assert!((3.5..5.0).contains(&kmh(turn_speed(&FOOT, 0.83, 1.0))));
        for r in [5.0, 50.0, 500.0, 5000.0] {
            assert!(turn_speed(&CAR, r, 1.0) <= (CAR.grip * CAR.safety * G * r).sqrt() + 1e-9);
        }
        assert!(turn_speed(&CAR, 30.0, 1.44) > turn_speed(&CAR, 30.0, 1.0));
    }

    #[test]
    fn junctions_curves_and_vehicles() {
        let (tl, c) = junction(90.0, 50.0, "car", 400.0);
        assert_eq!((tl.corners_slowed, tl.turns.len()), (1, 1));
        let t = &tl.turns[0];
        assert!((t.angle_deg - 90.0).abs() < 1.0 && t.radius_m > 6.0 && t.radius_m < 14.0, "{t:?}");
        let v = min_speed_near(&tl, c, 15.0);
        assert!((14.0..23.0).contains(&v), "{v}");
        assert_eq!(tl.summary()["turns"], 1);
        assert!(tl.summary()["sharpest_turn"]["speed_kmh"].as_f64().unwrap() < 23.0);
        // faster roads have bigger junctions
        let slow = junction(90.0, 30.0, "car", 400.0).0.turns[0].clone();
        let fast = junction(90.0, 80.0, "car", 400.0).0.turns[0].clone();
        assert!(slow.radius_m < t.radius_m && t.radius_m < fast.radius_m);
        // gentle kinks are not turns; shallow angles are taken faster
        assert!(junction(6.0, 50.0, "car", 400.0).0.turns.is_empty());
        assert!(junction(45.0, 50.0, "car", 400.0).0.turns[0].speed_kmh > t.speed_kmh + 10.0);
        // the leg mode picks the vehicle; a plane on a straight leg is not slowed
        assert!(junction(90.0, 18.0, "bike", 400.0).0.turns[0].speed_kmh < 12.0);
        let walk = junction(90.0, 5.0, "foot", 400.0).0.turns[0].speed_kmh;
        assert!(walk > 3.0 && walk < 5.0);
        let (plane, pc) = junction(90.0, 850.0, "straight", 40000.0);
        assert!(plane.turns.is_empty() && min_speed_near(&plane, pc, 400.0) > 800.0);
        assert_eq!(vehicle_for("straight", 50.0 / 3.6), Some(CAR));
        // a drawn curve keeps (about) its own radius
        let mut pts = vec![A, geo::destination(A, 90.0, 400.0)];
        let centre = geo::destination(pts[1], 180.0, 120.0);
        for i in 1..=19 {
            pts.push(geo::destination(centre, 90.0 * i as f64 / 19.0, 120.0));
        }
        let last = *pts.last().unwrap();
        pts.push(geo::destination(last, 180.0, 400.0));
        let end = *pts.last().unwrap();
        let mut leg = Leg::new(pts);
        leg.cruise_kmh = Some(90.0);
        leg.mode = "car".into();
        let s = ProfileSettings { accel_ms2: 2.0, decel_ms2: 2.0, corner_slowdown: true, ..Default::default() };
        let tl = build_timeline(&[Waypoint::at(A), Waypoint::at(end)], &[leg], &s).unwrap();
        assert_eq!(tl.turns.len(), 1);
        assert!((tl.turns[0].radius_m - 120.0).abs() < 18.0, "{:?}", tl.turns[0]);
        assert!((tl.turns[0].speed_kmh - turn_speed(&CAR, tl.turns[0].radius_m, 1.0) * 3.6).abs() < 0.2);
    }

    #[test]
    fn validation() {
        let (w, l) = straight(100.0);
        assert!(build_timeline(&w[..1], &[], &ProfileSettings::default()).is_err());
        let mut l2 = l.clone();
        l2[0].ramp = Ramp::Linear;
        assert!(build_timeline(&w, &l2, &ProfileSettings::default()).is_err());
        let s = ProfileSettings { accel_ms2: 0.0, ..Default::default() };
        assert!(build_timeline(&w, &l, &s).is_err());
    }
}
