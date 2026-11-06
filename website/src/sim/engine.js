// A compact port of the app's speed engine (browser/spoofer/profile.py) for the website demo.
//
// Kept: the leg speed limit, cornering limits (v = sqrt(lateral acceleration x radius), with the
// same vehicle table, bend detection and "drivers cut the corner" radius), start/stop at rest,
// and the forward/backward passes that accelerate and brake at a constant rate.
// Left out: road-aware speeds, speed limits, roundabouts, per-checkpoint speeds, waits and holds,
// linear ramps and ETA matching. Those need the routing service's extra data or the app itself.

const R_EARTH = 6371008.8;
const RAD = Math.PI / 180;
export const KMH = 1 / 3.6;
const G = 9.81;

// ---------- geometry ----------
export function distance(a, b) {
  const p1 = a[0] * RAD, p2 = b[0] * RAD;
  const dp = p2 - p1, dl = (b[1] - a[1]) * RAD;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearing(a, b) {
  const p1 = a[0] * RAD, p2 = b[0] * RAD, dl = (b[1] - a[1]) * RAD;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

export function destination(p, bearingDeg, metres) {
  const d = metres / R_EARTH, th = bearingDeg * RAD;
  const p1 = p[0] * RAD, l1 = p[1] * RAD;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(th));
  const l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [p2 / RAD, ((l2 / RAD + 540) % 360) - 180];
}

const lerp = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];

// Split a polyline so no step is longer than maxStep metres.
export function densify(points, maxStep) {
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const d = distance(a, b);
    const n = Math.max(1, Math.ceil(d / maxStep));
    for (let j = 1; j <= n; j++) out.push(j === n ? b : lerp(a, b, j / n));
  }
  return out;
}

// ---------- vehicles and cornering (same numbers as profile.py) ----------
const V = (aLatLow, aLatHigh, vHigh, grip, safety, minRadius, cutJunction, cutLane, vTypical) =>
  ({ aLatLow, aLatHigh, vHigh, grip, safety, minRadius, cutJunction, cutLane, vTypical });

export const VEHICLES = {
  car: V(2.8, 1.8, 30.0, 0.7, 0.55, 5.5, 4.0, 1.0, 13.9),
  bike: V(2.4, 2.0, 10.0, 0.6, 0.5, 2.5, 1.5, 0.5, 5.0),
  foot: V(1.6, 1.6, 3.0, 0.6, 0.6, 0.5, 0.4, 0.2, 1.4),
  sea: V(0.6, 0.4, 15.0, 1.0, 1.0, 40.0, 40.0, 15.0, 10.0),
};
const JUNCTION_LEN = 8.0;
const TURN_MIN_DEG = 10.0;
const TURN_NOISE_DEG = 0.3;
const TURN_WOBBLE_DEG = 4.0;
const TURN_GAP_S = 1.0;
const TURN_GAP_MIN_M = 10.0, TURN_GAP_MAX_M = 40.0;

export function vehicleFor(mode, cruiseMs) {
  if (VEHICLES[mode]) return VEHICLES[mode];
  const kmh = cruiseMs * 3.6;
  if (kmh <= 8) return VEHICLES.foot;
  if (kmh <= 30) return VEHICLES.bike;
  if (kmh <= 150) return VEHICLES.car;
  return null;
}

// Fastest comfortable speed (m/s) through a turn of this radius.
export function turnSpeed(veh, radius) {
  const r = Math.max(radius, veh.minRadius);
  const a0 = veh.aLatLow, a1 = veh.aLatHigh;
  const k = (a0 - a1) / veh.vHigh;
  let v = (-k * r + Math.sqrt((k * r) ** 2 + 4 * a0 * r)) / 2;
  if (v > veh.vHigh) v = Math.sqrt(a1 * r);
  return Math.min(v, Math.sqrt(veh.grip * veh.safety * G * r));
}

// Radius of the arc a driver follows through a bend of thetaDeg drawn over `length` metres.
export function drivenRadius(veh, thetaDeg, length, vRef, room) {
  const th = Math.min(thetaDeg, 179.9) * RAD;
  const rDrawn = length / (thetaDeg * RAD);
  const junction = Math.min(1, Math.max(0, 1 - length / (JUNCTION_LEN * veh.cutJunction)));
  const scale = Math.min(2, Math.max(0.6, vRef / veh.vTypical));
  const e = (veh.cutLane + (veh.cutJunction - veh.cutLane) * junction) * scale;
  const sec1 = 1 / Math.cos(th / 2) - 1;
  const rCut = rDrawn + e / sec1;
  const rFit = (room + length / 2) / Math.tan(th / 2);
  return Math.max(veh.minRadius, rDrawn, Math.min(rCut, rFit));
}

// Bends as [firstNode, lastNode, signed heading change in degrees].
function findBends(nodes, cum, gapAt) {
  const n = nodes.length;
  const delta = new Float64Array(n);
  let prev = null;
  for (let k = 0; k < n - 1; k++) {
    if (cum[k + 1] - cum[k] <= 0.05) continue;
    const b = bearing(nodes[k], nodes[k + 1]);
    if (prev !== null) delta[k] = ((b - prev + 540) % 360) - 180;
    prev = b;
  }
  const out = [];
  let cur = null; // [first, last, sum, sign]
  for (let k = 1; k < n - 1; k++) {
    const d = delta[k];
    if (Math.abs(d) < TURN_NOISE_DEG) continue;
    const sign = d > 0 ? 1 : -1;
    const near = cur !== null && cum[k] - cum[cur[1]] <= gapAt(k);
    if (near && (sign === cur[3] || Math.abs(d) <= TURN_WOBBLE_DEG)) {
      cur[1] = k; cur[2] += d;
      continue;
    }
    if (cur) out.push([cur[0], cur[1], cur[2]]);
    cur = [k, k, d, sign];
  }
  if (cur) out.push([cur[0], cur[1], cur[2]]);
  return out;
}

function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; }
  return lo;
}
function upperBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= x) lo = m + 1; else hi = m; }
  return lo;
}

function applyTurnCaps(nodes, cum, cap, nodeMode) {
  const n = nodes.length;
  if (n < 3) return [];
  const ref = Array.from(cap, (c) => (Number.isFinite(c) ? c : 0));
  const gapAt = (k) => Math.min(TURN_GAP_MAX_M, Math.max(TURN_GAP_MIN_M, TURN_GAP_S * ref[k]));
  const bends = findBends(nodes, cum, gapAt).filter((b) => Math.abs(b[2]) >= TURN_MIN_DEG);
  const total = cum[n - 1];
  const turns = [];
  bends.forEach(([k0, k1, ang], j) => {
    let vRef = Infinity;
    for (let k = k0; k <= k1; k++) vRef = Math.min(vRef, ref[k]);
    const veh = vehicleFor(nodeMode[k0], vRef);
    if (!veh || vRef <= 0) return;
    const before = j > 0 ? cum[k0] - cum[bends[j - 1][1]] : cum[k0];
    const after = j + 1 < bends.length ? cum[bends[j + 1][0]] - cum[k1] : total - cum[k1];
    const room = Math.max(0, Math.min(j > 0 ? before / 2 : before, j + 1 < bends.length ? after / 2 : after));
    const theta = Math.abs(ang);
    const length = cum[k1] - cum[k0];
    const radius = drivenRadius(veh, theta, length, vRef, room);
    const v = turnSpeed(veh, radius);
    const mid = (cum[k0] + cum[k1]) / 2;
    const half = Math.max(length / 2, (radius * theta * RAD) / 2);
    const lo = lowerBound(cum, mid - half), hi = upperBound(cum, mid + half);
    let slowed = false;
    for (let k = lo; k < hi; k++) if (v < cap[k] - 1e-9) { cap[k] = v; slowed = true; }
    turns.push({ s: mid, angle: ang, radius, kmh: Math.min(v, vRef) * 3.6, slowed });
  });
  return turns;
}

// ---------- timeline ----------
// legs: [{ points: [[lat, lon], ...], kmh, mode }] in order; each leg starts where the last ended.
export function buildTimeline(legs, { accel = 1, decel = 1, corners = true, maxStep = 3 } = {}) {
  const nodes = [];
  const nodeMode = [];
  const nodeCap = [];
  legs.forEach((leg, i) => {
    const pts = densify(leg.points, maxStep);
    const start = i === 0 ? 0 : 1; // the first point repeats the last leg's end
    for (let j = start; j < pts.length; j++) {
      nodes.push(pts[j]);
      nodeMode.push(leg.mode);
      nodeCap.push(leg.kmh * KMH);
    }
  });
  const n = nodes.length;
  if (n < 2) throw new Error("A route needs at least two different points.");
  const cum = new Float64Array(n);
  for (let k = 1; k < n; k++) cum[k] = cum[k - 1] + distance(nodes[k - 1], nodes[k]);
  if (cum[n - 1] < 1) throw new Error("The checkpoints are on the same spot.");

  // each step is limited by the slower of its two ends' legs (as in profile.py)
  const cap = new Float64Array(n).fill(Infinity);
  for (let k = 0; k < n - 1; k++) {
    const c = nodeCap[k + 1];
    cap[k] = Math.min(cap[k], c);
    cap[k + 1] = Math.min(cap[k + 1], c);
  }
  const turns = corners ? applyTurnCaps(nodes, cum, cap, nodeMode) : [];
  cap[0] = 0; // start from rest
  cap[n - 1] = 0; // stop at the end

  const v = Float64Array.from(cap);
  for (let k = 0; k < n - 1; k++) {
    const ds = cum[k + 1] - cum[k];
    v[k + 1] = Math.min(v[k + 1], Math.sqrt(v[k] * v[k] + 2 * accel * ds));
  }
  for (let k = n - 2; k >= 0; k--) {
    const ds = cum[k + 1] - cum[k];
    v[k] = Math.min(v[k], Math.sqrt(v[k + 1] * v[k + 1] + 2 * decel * ds));
  }

  const t = new Float64Array(n);
  for (let k = 0; k < n - 1; k++) {
    const ds = cum[k + 1] - cum[k];
    const vs = v[k] + v[k + 1];
    t[k + 1] = t[k] + (ds <= 0 ? 0 : vs < 0.05 ? (2 * ds) / 0.05 : (2 * ds) / vs);
  }
  return { nodes, cum, v, t, turns, distance: cum[n - 1], duration: t[n - 1] };
}

// Position, speed (m/s), heading and distance travelled at time `time` (s) on a timeline.
export function sampleAt(tl, time) {
  const { nodes, cum, v, t } = tl;
  const n = nodes.length;
  if (time <= 0) return at(tl, 0, 0, 0);
  if (time >= t[n - 1]) return at(tl, n - 2, 1, cum[n - 1]);
  const k = Math.max(0, upperBound(t, time) - 1);
  const dt = t[k + 1] - t[k];
  const ds = cum[k + 1] - cum[k];
  if (dt <= 0 || ds <= 0) return at(tl, k, 0, cum[k]);
  const tau = time - t[k];
  const a = (v[k + 1] - v[k]) / dt;
  const s = Math.min(ds, v[k] * tau + 0.5 * a * tau * tau);
  const f = s / ds;
  return at(tl, k, f, cum[k] + s, v[k] + a * tau);
}

function at(tl, k, f, s, speed) {
  const { nodes, cum, v } = tl;
  const pos = lerp(nodes[k], nodes[k + 1], f);
  return { pos, speed: speed ?? v[k] + (v[k + 1] - v[k]) * f, heading: headingAt(tl, s), s, total: cum[cum.length - 1] };
}

// Heading over a short window ahead (and behind at the very end), so it turns smoothly.
export function headingAt(tl, s, window = 8) {
  const total = tl.cum[tl.cum.length - 1];
  const s0 = Math.max(0, Math.min(s, total - window));
  const s1 = Math.min(total, s0 + window);
  return bearing(pointAtDistance(tl, s0), pointAtDistance(tl, s1));
}

export function pointAtDistance(tl, s) {
  const { nodes, cum } = tl;
  const n = nodes.length;
  if (s <= 0) return nodes[0];
  if (s >= cum[n - 1]) return nodes[n - 1];
  const k = Math.max(0, upperBound(cum, s) - 1);
  const ds = cum[k + 1] - cum[k];
  return ds > 0 ? lerp(nodes[k], nodes[k + 1], (s - cum[k]) / ds) : nodes[k];
}
