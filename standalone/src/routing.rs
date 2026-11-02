//! Routing providers: OSRM (OpenStreetMap), Google Routes API, sea lanes, straight lines,
//! plus place search and OpenStreetMap speed limits. Mirrors routing.py / google_api.py /
//! road_speed.py of the browser version.

use crate::geo::{self, LatLon};
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const USER_AGENT: &str = "LocationSpoofer-Standalone/0.1 (desktop app)";
const OFFNET_MIN_M: f64 = 25.0;
const OFFNET_CAP_KMH: f64 = 15.0;
const RESTRICTED_CAP_KMH: f64 = 20.0;

/// The public FOSSGIS servers allow at most one request per second
/// (https://routing.openstreetmap.de/about.html). Your own OSRM server (SPOOFER_OSRM_*) is not throttled.
const OSRM_PUBLIC_HOST: &str = "routing.openstreetmap.de";
const OSRM_MIN_INTERVAL: Duration = Duration::from_secs(1);

/// Alternative routes. OSRM returns at most one alternative in practice, so extra ones are found by
/// routing through a "via" point beside the main route and keeping only detours that are sensible.
pub const MAX_ALTERNATIVES: usize = 3;
const VIA_OFFSETS: [f64; 4] = [0.2, -0.2, 0.35, -0.35]; // sideways offset of the via point, share of the leg length
pub const MAX_VIA_REQUESTS: usize = 6; // extra routing requests per route build, on top of one per leg
const MIN_ALT_LEG_M: f64 = 400.0;
const ALT_MAX_DURATION_RATIO: f64 = 1.5;
const ALT_MAX_DISTANCE_RATIO: f64 = 1.6;
const ALT_MAX_OVERLAP: f64 = 0.8; // share of road segments a detour may share with an already chosen route
const VIA_MAX_TURN_DEG: f64 = 150.0; // a sharper turn at the via point is a U-turn "spike"
// A detour may not turn back on itself more often than the main route does: a heading reversal of
// more than REVERSAL_MIN_DEG over REVERSAL_WINDOW x REVERSAL_STEP_M either side of a point (up one
// street and back down the next, or a lap round a block) is not a real alternative.
const REVERSAL_STEP_M: f64 = 50.0;
const REVERSAL_WINDOW: usize = 6;
const REVERSAL_MIN_DEG: f64 = 135.0;

#[derive(Clone, Debug, Default)]
pub struct RouteResult {
    pub points: Vec<LatLon>,
    pub provider: String,
    pub zones: Option<Vec<(f64, Option<f64>)>>,
    pub ref_duration_s: Option<f64>,
    pub features: HashMap<String, f64>,
    pub notes: Vec<String>,
    pub exportable: bool,
    /// "main", "alternative" (offered by the provider) or "detour" (found through a via point)
    pub kind: String,
}

/// How many extra (via point) routing requests one route build may still make.
pub struct ViaBudget {
    pub left: usize,
}

impl Default for ViaBudget {
    fn default() -> Self {
        Self { left: MAX_VIA_REQUESTS }
    }
}

/// Progress messages from inside a leg ("Searching for alternative routes", ...).
pub type Report<'a> = &'a (dyn Fn(&str) + Send + Sync);

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

pub fn http() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("http client")
    })
}

fn cache() -> &'static Mutex<HashMap<String, Vec<RouteResult>>> {
    static C: OnceLock<Mutex<HashMap<String, Vec<RouteResult>>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_put(key: String, v: Vec<RouteResult>) {
    let mut c = cache().lock().unwrap();
    if c.len() > 300 {
        c.clear();
    }
    c.insert(key, v);
}

/// The main path from a to b, then up to `count` alternative paths (fastest first).
/// Sea and straight legs have no alternatives.
#[allow(clippy::too_many_arguments)]
pub async fn route_options(
    a: LatLon,
    b: LatLon,
    mode: &str,
    provider: &str,
    google_key: Option<&str>,
    road_data: bool,
    count: usize,
    budget: &mut ViaBudget,
    report: Report<'_>,
) -> Result<Vec<RouteResult>, String> {
    if !["car", "bike", "foot", "sea", "straight"].contains(&mode) {
        return Err(format!("Unknown travel mode '{mode}'"));
    }
    let count = count.min(MAX_ALTERNATIVES);
    if mode == "straight" || geo::haversine_m(a, b) < 1.0 {
        return Ok(vec![RouteResult { points: vec![a, b], provider: "straight".into(), exportable: true, kind: "main".into(), ..Default::default() }]);
    }
    let r6 = |p: LatLon| format!("{:.6},{:.6}", p.0, p.1);
    if mode == "sea" {
        let key = format!("sea|{}|{}", r6(a), r6(b));
        if let Some(hit) = cache().lock().unwrap().get(&key) {
            return Ok(hit.clone());
        }
        let pts = tokio::task::spawn_blocking(move || sea_route(a, b)).await.map_err(|e| e.to_string())??;
        let res = vec![RouteResult { points: pts, provider: "searoute".into(), exportable: true, kind: "main".into(), ..Default::default() }];
        cache_put(key, res.clone());
        return Ok(res);
    }
    if provider == "google" {
        let key = google_key.ok_or("Google routing needs an API key (Settings > Google Maps)")?;
        return google_routes(a, b, mode, key, count).await;
    }
    let key = format!("osrm|{mode}|{}|{}|{road_data}|{count}", r6(a), r6(b));
    if let Some(hit) = cache().lock().unwrap().get(&key) {
        return Ok(hit.clone());
    }
    let (res, complete) = osrm_options(a, b, mode, road_data, count, budget, report).await?;
    if complete {
        // a search cut short by the request budget may find more next time
        cache_put(key, res.clone());
    }
    Ok(res)
}

/// Reserve the next request slot: how long to wait so requests start at least `interval` apart.
fn reserve_slot(next: &mut Option<Instant>, now: Instant, interval: Duration) -> Duration {
    let start = match *next {
        Some(n) if n > now => n,
        _ => now,
    };
    *next = Some(start + interval);
    start - now
}

fn osrm_wait(base: &str) -> Duration {
    static NEXT: Mutex<Option<Instant>> = Mutex::new(None);
    if !base.contains(OSRM_PUBLIC_HOST) {
        return Duration::ZERO;
    }
    reserve_slot(&mut NEXT.lock().unwrap(), Instant::now(), OSRM_MIN_INTERVAL)
}

fn with_connectors(a: LatLon, b: LatLon, pts: &[LatLon], seg: &[Option<f64>], mode: &str) -> (Vec<LatLon>, Vec<(f64, Option<f64>)>, f64) {
    let mut full = Vec::with_capacity(pts.len() + 2);
    full.push(a);
    full.extend_from_slice(pts);
    full.push(b);
    let d0 = geo::haversine_m(a, pts[0]);
    let d1 = geo::haversine_m(*pts.last().unwrap(), b);
    let off_cap = if mode == "car" { Some(OFFNET_CAP_KMH / 3.6) } else { None };
    let mut speeds = Vec::with_capacity(full.len());
    speeds.push(if d0 >= OFFNET_MIN_M { off_cap } else { seg.first().copied().flatten() });
    speeds.extend_from_slice(seg);
    speeds.push(if d1 >= OFFNET_MIN_M { off_cap } else { seg.last().copied().flatten() });
    let mut offnet = 0.0;
    for d in [d0, d1] {
        if d >= OFFNET_MIN_M {
            offnet += d;
        }
    }
    let mut zones = Vec::with_capacity(full.len());
    let mut s = 0.0;
    for (w, v) in full.windows(2).zip(speeds) {
        s += geo::haversine_m(w[0], w[1]);
        zones.push((s, v));
    }
    (full, zones, offnet)
}

fn osrm_base(mode: &str) -> String {
    match mode {
        "car" => env_or("SPOOFER_OSRM_CAR", "https://routing.openstreetmap.de/routed-car"),
        "bike" => env_or("SPOOFER_OSRM_BIKE", "https://routing.openstreetmap.de/routed-bike"),
        _ => env_or("SPOOFER_OSRM_FOOT", "https://routing.openstreetmap.de/routed-foot"),
    }
}

async fn osrm_fetch(coords: &[LatLon], mode: &str, alternatives: usize) -> Result<Value, String> {
    let base = osrm_base(mode);
    let path: Vec<String> = coords.iter().map(|p| format!("{:.6},{:.6}", p.1, p.0)).collect();
    let mut alt = alternatives;
    loop {
        let mut url = format!(
            "{}/route/v1/driving/{}?overview=full&geometries=geojson&steps=true&annotations=speed,nodes",
            base.trim_end_matches('/'),
            path.join(";")
        );
        if alt > 0 {
            url.push_str(&format!("&alternatives={alt}"));
        }
        let wait = osrm_wait(&base);
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
        let r = http().get(&url).send().await.map_err(|e| {
            format!("Could not reach the {mode} routing server ({e}). Check your internet connection, switch to Google routing, or use 'straight'.")
        })?;
        if r.status().as_u16() == 429 {
            return Err("The routing server is rate-limiting requests. Wait a moment and try again.".into());
        }
        let status = r.status();
        let data: Value = r.json().await.map_err(|_| format!("Routing server returned HTTP {}", status.as_u16()))?;
        if data["code"] == "Ok" && data["routes"].as_array().is_some_and(|x| !x.is_empty()) {
            return Ok(data);
        }
        if alt > 0 && data["code"] == "TooBig" {
            alt = 0; // a self-hosted server may allow fewer alternatives: ask for the main route only
            continue;
        }
        return Err(format!("No {mode} route found: {}", data["message"].as_str().or(data["code"].as_str()).unwrap_or("unknown error")));
    }
}

const UNKNOWN_NODE: i64 = -1; // an OSM node id OSRM could not report exactly

struct Candidate {
    pts: Vec<LatLon>,
    speeds: Vec<Option<f64>>,
    nodes: Vec<Vec<i64>>, // OSM node ids per OSRM leg (a detour has two legs)
    uturns: f64,
    duration: f64,
    distance: f64,
    kind: &'static str,
    via_turn: f64, // turn angle at the via point, degrees (0 = straight on)
}

impl Candidate {
    /// True when the path uses a road segment twice (a loop round a block or a spike to the via
    /// point and back). The segment the via point sits on may end one leg and start the next when
    /// the path carries straight on (same direction); driving it back counts.
    fn doubles_back(&self) -> bool {
        let key = |a: i64, b: i64| if a < b { (a, b) } else { (b, a) };
        let mut seen = HashSet::new();
        for (k, ns) in self.nodes.iter().enumerate() {
            for (i, w) in ns.windows(2).enumerate() {
                if w[0] <= 0 || w[1] <= 0 {
                    continue;
                }
                let pair = key(w[0], w[1]);
                let prev = if k > 0 { &self.nodes[k - 1] } else { ns };
                let junction = i == 0 && k > 0 && prev.len() >= 2 && (w[0], w[1]) == (prev[prev.len() - 2], prev[prev.len() - 1]);
                if !seen.insert(pair) && !junction {
                    return true;
                }
            }
        }
        false
    }

    fn pairs(&self) -> HashSet<(i64, i64)> {
        let mut out = HashSet::new();
        for ns in &self.nodes {
            for w in ns.windows(2).filter(|w| w[0] > 0 && w[1] > 0) {
                out.insert(if w[0] < w[1] { (w[0], w[1]) } else { (w[1], w[0]) });
            }
        }
        out
    }
}

fn parse_osrm(rt: &Value, kind: &'static str) -> Option<Candidate> {
    let pts: Vec<LatLon> = rt["geometry"]["coordinates"]
        .as_array()
        .map(|c| c.iter().filter_map(|p| Some((p[1].as_f64()?, p[0].as_f64()?))).collect())
        .unwrap_or_default();
    if pts.len() < 2 {
        return None;
    }
    let mut speeds: Vec<Option<f64>> = Vec::new();
    let mut nodes: Vec<Vec<i64>> = Vec::new();
    let mut uturns = 0.0;
    let legs: Vec<&Value> = rt["legs"].as_array().into_iter().flatten().collect();
    for leg in &legs {
        for v in leg["annotation"]["speed"].as_array().into_iter().flatten() {
            speeds.push(v.as_f64().filter(|x| *x > 0.0));
        }
        // OSRM writes node ids of 10 billion and up as rounded floats (1.134297535e+10), which no
        // longer name one node: keep their place in the list (so it lines up with the speeds) as unknown.
        nodes.push(leg["annotation"]["nodes"].as_array().into_iter().flatten().map(|n| n.as_i64().filter(|v| *v > 0).unwrap_or(UNKNOWN_NODE)).collect());
        for st in leg["steps"].as_array().into_iter().flatten() {
            if st["maneuver"]["modifier"] == "uturn" {
                uturns += 1.0;
            }
        }
    }
    if speeds.len() != pts.len() - 1 {
        speeds = vec![None; pts.len() - 1];
    }
    let mut via_turn: f64 = 0.0;
    for w in legs.windows(2) {
        let before = w[0]["steps"].as_array().and_then(|s| s.last()).and_then(|s| s["maneuver"]["bearing_before"].as_f64());
        let after = w[1]["steps"].as_array().and_then(|s| s.first()).and_then(|s| s["maneuver"]["bearing_after"].as_f64());
        if let (Some(x), Some(y)) = (before, after) {
            via_turn = via_turn.max(((y - x + 540.0) % 360.0 - 180.0).abs());
        }
    }
    Some(Candidate {
        pts,
        speeds,
        nodes,
        uturns,
        duration: rt["duration"].as_f64().unwrap_or(0.0),
        distance: rt["distance"].as_f64().unwrap_or(0.0),
        kind,
        via_turn,
    })
}

/// Points every `step` metres along a polyline.
fn resample(pts: &[LatLon], step: f64) -> Vec<LatLon> {
    let mut out = vec![pts[0]];
    let mut carry = 0.0; // distance from the last sample to the start of the current segment
    for w in pts.windows(2) {
        let d = geo::haversine_m(w[0], w[1]);
        if d <= 0.0 {
            continue;
        }
        let mut t = step - carry;
        while t <= d {
            out.push(geo::interpolate(w[0], w[1], t / d));
            t += step;
        }
        carry = d - (t - step);
    }
    out
}

/// How many times the path turns back on itself (see REVERSAL_MIN_DEG).
fn reversals(pts: &[LatLon]) -> usize {
    if pts.len() < 2 {
        return 0;
    }
    let (r, w) = (resample(pts, REVERSAL_STEP_M), REVERSAL_WINDOW);
    let (mut events, mut inside) = (0, false);
    for i in w..r.len().saturating_sub(w) {
        let (b1, b2) = (geo::bearing_deg(r[i - w], r[i]), geo::bearing_deg(r[i], r[i + w]));
        if ((b2 - b1 + 540.0) % 360.0 - 180.0).abs() > REVERSAL_MIN_DEG {
            if !inside {
                events += 1;
            }
            inside = true;
        } else {
            inside = false;
        }
    }
    events
}

fn point_at_fraction(pts: &[LatLon], f: f64) -> LatLon {
    let mut cum = vec![0.0];
    for w in pts.windows(2) {
        cum.push(cum.last().unwrap() + geo::haversine_m(w[0], w[1]));
    }
    let target = cum.last().unwrap() * f;
    let i = cum.partition_point(|c| *c < target).max(1);
    if i >= pts.len() {
        return *pts.last().unwrap();
    }
    let seg = cum[i] - cum[i - 1];
    geo::interpolate(pts[i - 1], pts[i], if seg > 0.0 { (target - cum[i - 1]) / seg } else { 0.0 })
}

/// Whether a detour is worth offering next to the routes already found.
fn detour_ok(c: &Candidate, main: &Candidate, taken: &[HashSet<(i64, i64)>]) -> bool {
    if c.via_turn > VIA_MAX_TURN_DEG || c.uturns > main.uturns || c.doubles_back() {
        return false; // it turns back at the via point or drives a road twice
    }
    if reversals(&c.pts) > reversals(&main.pts) {
        return false; // up one street and back down the next: not a real alternative
    }
    if main.duration > 0.0 && c.duration > main.duration * ALT_MAX_DURATION_RATIO {
        return false;
    }
    if main.distance > 0.0 && c.distance > main.distance * ALT_MAX_DISTANCE_RATIO {
        return false;
    }
    let pairs = c.pairs();
    pairs.is_empty() || taken.iter().all(|t| (pairs.intersection(t).count() as f64) / (pairs.len() as f64) <= ALT_MAX_OVERLAP)
}

/// Detour alternatives through via points on either side of the main route.
/// Returns false when the request budget ran out before the search finished.
async fn add_detours(a: LatLon, b: LatLon, mode: &str, cands: &mut Vec<Candidate>, count: usize, budget: &mut ViaBudget, report: Report<'_>) -> bool {
    let length = geo::haversine_m(a, b);
    if length < MIN_ALT_LEG_M {
        return true;
    }
    let mid = point_at_fraction(&cands[0].pts, 0.5);
    let heading = geo::bearing_deg(a, b);
    let mut taken: Vec<HashSet<(i64, i64)>> = cands.iter().map(|c| c.pairs()).collect();
    for f in VIA_OFFSETS {
        if cands.len() > count {
            return true;
        }
        if budget.left == 0 {
            return false;
        }
        budget.left -= 1;
        report("Searching for alternative routes");
        let via = geo::destination(mid, (heading + if f > 0.0 { 90.0 } else { -90.0 }).rem_euclid(360.0), f.abs() * length);
        let data = match osrm_fetch(&[a, via, b], mode, 0).await {
            Ok(d) => d,
            Err(e) => {
                tracing::info!("detour search failed: {e}");
                continue;
            }
        };
        let Some(c) = parse_osrm(&data["routes"][0], "detour") else { continue };
        if detour_ok(&c, &cands[0], &taken) {
            taken.push(c.pairs());
            cands.push(c);
        }
    }
    true
}

async fn osrm_options(a: LatLon, b: LatLon, mode: &str, road_data: bool, count: usize, budget: &mut ViaBudget, report: Report<'_>) -> Result<(Vec<RouteResult>, bool), String> {
    let data = osrm_fetch(&[a, b], mode, count).await?;
    let mut cands: Vec<Candidate> = data["routes"]
        .as_array()
        .into_iter()
        .flatten()
        .take(1 + count)
        .enumerate()
        .filter_map(|(i, rt)| parse_osrm(rt, if i == 0 { "main" } else { "alternative" }))
        .collect();
    if cands.is_empty() {
        return Err("The routing server returned an empty route".into());
    }
    let mut complete = true;
    if cands.len() - 1 < count {
        complete = add_detours(a, b, mode, &mut cands, count, budget, report).await;
    }
    if cands.len() > 2 {
        cands[1..].sort_by(|x, y| x.duration.partial_cmp(&y.duration).unwrap_or(std::cmp::Ordering::Equal));
    }
    let mut infos: Vec<Option<RoadInfo>> = (0..cands.len()).map(|_| None).collect();
    let mut overpass_error = false;
    let has_nodes = cands.iter().any(|c| c.nodes.iter().any(|n| !n.is_empty()));
    if road_data && mode == "car" && has_nodes {
        report("Analysing speed-limit data (OpenStreetMap)");
        let flat: Vec<Vec<i64>> = cands.iter().flat_map(|c| c.nodes.clone()).collect();
        match fetch_osm_roads_multi(&flat).await {
            Ok(got) => {
                let mut k = 0;
                for (i, c) in cands.iter().enumerate() {
                    infos[i] = Some(RoadInfo::concat(&got[k..k + c.nodes.len()]));
                    k += c.nodes.len();
                }
            }
            Err(e) => {
                tracing::info!("overpass failed: {e}");
                overpass_error = true;
            }
        }
    }
    let mut out = Vec::with_capacity(cands.len());
    for (c, info) in cands.iter().zip(infos) {
        let mut speeds = c.speeds.clone();
        let mut notes = Vec::new();
        let mut features: HashMap<String, f64> = HashMap::from([("uturns".into(), c.uturns)]);
        if road_data && mode == "car" && c.nodes.iter().any(|n| !n.is_empty()) {
            match info {
                _ if overpass_error => notes.push("Public speed-limit data (OpenStreetMap Overpass) was unavailable; used typical road speeds.".into()),
                Some(info) if info.limits.len() == speeds.len() => {
                    apply_osm(&mut speeds, &info, &mut features);
                    notes.push(format!("Speed limits known for {:.0}% of this leg ({}).", info.coverage * 100.0, info.source));
                }
                Some(info) if !info.source.is_empty() => notes.push(format!("Speed-limit data {}.", info.source)),
                _ => {}
            }
        }
        let (full, zones, offnet) = with_connectors(a, b, &c.pts, &speeds, mode);
        features.insert("offnet_m".into(), offnet);
        out.push(RouteResult {
            points: full,
            provider: "osrm".into(),
            zones: Some(zones),
            ref_duration_s: Some(c.duration).filter(|d| *d > 0.0),
            features,
            notes,
            exportable: true,
            kind: c.kind.into(),
        });
    }
    Ok((out, complete))
}

fn apply_osm(speeds: &mut [Option<f64>], info: &RoadInfo, features: &mut HashMap<String, f64>) {
    let (mut hw, mut rs) = (0.0, 0.0);
    for (v, (kind, limit)) in speeds.iter_mut().zip(info.kinds.iter().zip(&info.limits)) {
        if *kind == "restricted" {
            rs += 1.0;
            let cap = RESTRICTED_CAP_KMH / 3.6;
            *v = Some(v.map(|x| x.min(cap)).unwrap_or(cap));
        }
        if *kind == "highway" {
            hw += 1.0;
        }
        if let Some(lim) = limit {
            let l = lim / 3.6;
            *v = Some(v.map(|x| x.min(l)).unwrap_or(l * 0.9));
        }
    }
    features.insert("highway_segments".into(), hw);
    features.insert("restricted_segments".into(), rs);
}

// ---------------------------------------------------------------- OpenStreetMap speed limits
pub fn parse_maxspeed(value: Option<&str>) -> Option<f64> {
    let v = value?.trim().to_lowercase();
    let num = Regex::new(r"^(\d+(?:\.\d+)?)\s*(mph|km/h|kmh|kph|knots)?$").unwrap();
    let zone = |z: &str| -> Option<f64> {
        Some(match z {
            "urban" => 50.0,
            "rural" => 90.0,
            "motorway" => 130.0,
            "trunk" => 100.0,
            "living_street" => 7.0,
            "zone30" => 30.0,
            "zone20" => 20.0,
            "bicycle_road" | "school" => 30.0,
            "walk" => 7.0,
            _ => return None,
        })
    };
    let mut best: Option<f64> = None;
    for part in v.split([';', '|']).map(str::trim) {
        let speed = if let Some(c) = num.captures(part) {
            let s: f64 = c[1].parse().ok()?;
            Some(match c.get(2).map(|m| m.as_str()) {
                Some("mph") => s * 1.609344,
                Some("knots") => s * 1.852,
                _ => s,
            })
        } else if part == "walk" {
            Some(7.0)
        } else if let Some((_, z)) = part.split_once(':') {
            zone(z)
        } else {
            None
        };
        if let Some(s) = speed.filter(|s| *s > 0.0) {
            best = Some(best.map(|b: f64| b.min(s)).unwrap_or(s));
        }
    }
    best
}

fn classify(tags: &serde_json::Map<String, Value>) -> &'static str {
    let get = |k: &str| tags.get(k).and_then(|v| v.as_str()).unwrap_or("");
    let hw = get("highway");
    if ["motorway", "motorway_link", "trunk", "trunk_link"].contains(&hw) {
        return "highway";
    }
    let access = [get("motor_vehicle"), get("motorcar"), get("vehicle"), get("access")].into_iter().find(|s| !s.is_empty()).unwrap_or("");
    if ["private", "destination", "customers", "delivery", "permit", "no"].contains(&access)
        || ["driveway", "parking_aisle", "drive-through", "alley"].contains(&get("service"))
        || hw == "service"
        || hw == "track"
    {
        return "restricted";
    }
    if hw.is_empty() { "" } else { "road" }
}

/// Speed limits and road classes for consecutive OSM node pairs along one node sequence.
#[derive(Clone, Debug, Default)]
struct RoadInfo {
    limits: Vec<Option<f64>>,
    kinds: Vec<&'static str>,
    coverage: f64,
    source: String,
}

impl RoadInfo {
    /// Join the per-leg info of one multi-leg OSRM route (a via-point detour).
    fn concat(parts: &[RoadInfo]) -> RoadInfo {
        let mut out = RoadInfo::default();
        for p in parts {
            out.limits.extend_from_slice(&p.limits);
            out.kinds.extend_from_slice(&p.kinds);
            if out.source.is_empty() {
                out.source = p.source.clone();
            }
        }
        let known = out.limits.iter().filter(|l| l.is_some()).count();
        out.coverage = known as f64 / out.limits.len().max(1) as f64;
        out
    }
}

/// One set of Overpass queries for several node sequences (route alternatives): nodes they share
/// are only looked up once.
async fn fetch_osm_roads_multi(lists: &[Vec<i64>]) -> Result<Vec<RoadInfo>, String> {
    let mut infos: Vec<RoadInfo> = lists
        .iter()
        .map(|n| RoadInfo { limits: vec![None; n.len().saturating_sub(1)], kinds: vec![""; n.len().saturating_sub(1)], ..Default::default() })
        .collect();
    let mut seen = HashSet::new();
    let unique: Vec<i64> = lists.iter().flatten().copied().filter(|x| *x > 0 && seen.insert(*x)).collect();
    if unique.len() < 2 {
        return Ok(infos);
    }
    if unique.len() > 6000 {
        for i in &mut infos {
            i.source = "skipped (route too long for the public speed-limit service)".into();
        }
        return Ok(infos);
    }
    let url = env_or("SPOOFER_OVERPASS", "https://overpass-api.de/api/interpreter");
    let mut pair: HashMap<(i64, i64), serde_json::Map<String, Value>> = HashMap::new();
    for chunk in unique.chunks(1500) {
        let ids: Vec<String> = chunk.iter().map(|x| x.to_string()).collect();
        let q = format!("[out:json][timeout:25];node(id:{});way(bn)[highway];out body qt;", ids.join(","));
        let r = http().post(&url).form(&[("data", q)]).send().await.map_err(|e| e.to_string())?;
        if !r.status().is_success() {
            return Err(format!("HTTP {}", r.status().as_u16()));
        }
        let d: Value = r.json().await.map_err(|e| e.to_string())?;
        for el in d["elements"].as_array().into_iter().flatten() {
            if el["type"] != "way" {
                continue;
            }
            let tags = el["tags"].as_object().cloned().unwrap_or_default();
            let nds: Vec<i64> = el["nodes"].as_array().into_iter().flatten().filter_map(|x| x.as_i64()).collect();
            for w in nds.windows(2) {
                pair.insert((w[0], w[1]), tags.clone());
                pair.insert((w[1], w[0]), tags.clone());
            }
        }
    }
    for (nodes, info) in lists.iter().zip(infos.iter_mut()) {
        let mut known = 0;
        for i in 0..nodes.len().saturating_sub(1) {
            if let Some(tags) = pair.get(&(nodes[i], nodes[i + 1])) {
                info.kinds[i] = classify(tags);
                info.limits[i] = parse_maxspeed(tags.get("maxspeed").and_then(|v| v.as_str()));
                if info.limits[i].is_some() {
                    known += 1;
                }
            }
        }
        info.coverage = known as f64 / nodes.len().saturating_sub(1).max(1) as f64;
        info.source = "OpenStreetMap (Overpass)".into();
    }
    Ok(infos)
}

// ---------------------------------------------------------------- Google
pub fn decode_polyline(encoded: &str) -> Result<Vec<LatLon>, String> {
    let bytes = encoded.as_bytes();
    let (mut i, mut lat, mut lng) = (0usize, 0i64, 0i64);
    let mut out = Vec::new();
    while i < bytes.len() {
        for which in 0..2 {
            let (mut shift, mut result) = (0u32, 0i64);
            loop {
                let b = *bytes.get(i).ok_or("Malformed polyline from Google")? as i64 - 63;
                i += 1;
                result |= (b & 0x1f) << shift;
                shift += 5;
                if b < 0x20 {
                    break;
                }
                if shift > 60 {
                    return Err("Malformed polyline from Google".into());
                }
            }
            let delta = if result & 1 != 0 { !(result >> 1) } else { result >> 1 };
            if which == 0 {
                lat += delta;
            } else {
                lng += delta;
            }
        }
        out.push((lat as f64 / 1e5, lng as f64 / 1e5));
    }
    Ok(out)
}

fn seconds(v: &Value) -> f64 {
    v.as_str().and_then(|s| s.strip_suffix('s')).and_then(|s| s.parse().ok()).unwrap_or(0.0)
}

fn google_error(status: u16, body: &Value, text: &str) -> String {
    let msg = body["error"]["message"].as_str().unwrap_or(text);
    if status == 401 || status == 403 || body["error"]["status"] == "PERMISSION_DENIED" {
        format!("Google refused the API key: {msg} (enable 'Routes API' and 'Map Tiles API' for the key)")
    } else {
        format!("Google API error {status}: {msg}")
    }
}

/// The default route, then (with `count` > 0) up to three alternatives Google offers. Alternatives
/// arrive in the same response, so no extra requests are made.
async fn google_routes(a: LatLon, b: LatLon, mode: &str, key: &str, count: usize) -> Result<Vec<RouteResult>, String> {
    let travel = match mode {
        "car" => "DRIVE",
        "bike" => "BICYCLE",
        "foot" => "WALK",
        _ => return Err(format!("Google routing does not support the '{mode}' mode")),
    };
    let mut body = json!({
        "origin": {"location": {"latLng": {"latitude": a.0, "longitude": a.1}}},
        "destination": {"location": {"latLng": {"latitude": b.0, "longitude": b.1}}},
        "travelMode": travel,
        "polylineQuality": "HIGH_QUALITY",
        "polylineEncoding": "ENCODED_POLYLINE",
    });
    if travel == "DRIVE" {
        body["routingPreference"] = json!("TRAFFIC_AWARE");
    }
    if count > 0 {
        body["computeAlternativeRoutes"] = json!(true);
    }
    let mask = "routes.duration,routes.staticDuration,routes.distanceMeters,routes.polyline.encodedPolyline,\
routes.legs.steps.distanceMeters,routes.legs.steps.staticDuration,routes.legs.steps.polyline.encodedPolyline,\
routes.legs.steps.navigationInstruction.maneuver,routes.warnings,routes.routeLabels";
    let r = http()
        .post("https://routes.googleapis.com/directions/v2:computeRoutes")
        .header("X-Goog-Api-Key", key)
        .header("X-Goog-FieldMask", mask)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Could not reach Google ({e})"))?;
    let status = r.status().as_u16();
    let text = r.text().await.unwrap_or_default();
    let data: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if status != 200 {
        return Err(google_error(status, &data, &text));
    }
    let routes: Vec<&Value> = data["routes"].as_array().into_iter().flatten().take(1 + count).collect();
    let first = routes.first().ok_or(format!("Google found no {mode} route between these points"))?;
    let mut out = vec![google_result(a, b, mode, first)?];
    for rt in &routes[1..] {
        if let Ok(mut r) = google_result(a, b, mode, rt) {
            r.kind = "alternative".into();
            out.push(r);
        }
    }
    Ok(out)
}

fn google_result(a: LatLon, b: LatLon, mode: &str, route: &Value) -> Result<RouteResult, String> {
    let pts = decode_polyline(route["polyline"]["encodedPolyline"].as_str().unwrap_or(""))?;
    if pts.len() < 2 {
        return Err("Google returned an empty route".into());
    }
    let dist = route["distanceMeters"].as_f64().unwrap_or_else(|| geo::polyline_length(&pts));
    let mut steps: Vec<(f64, Option<f64>, String)> = Vec::new();
    let mut s = 0.0;
    for leg in route["legs"].as_array().into_iter().flatten() {
        for st in leg["steps"].as_array().into_iter().flatten() {
            let d = st["distanceMeters"].as_f64().unwrap_or(0.0);
            let t = seconds(&st["staticDuration"]);
            s += d;
            steps.push((s, (t > 0.0 && d > 0.0).then(|| d / t), st["navigationInstruction"]["maneuver"].as_str().unwrap_or("").into()));
        }
    }
    let scale = if dist > 0.0 { geo::polyline_length(&pts) / dist } else { 1.0 };
    let mut seg = Vec::with_capacity(pts.len() - 1);
    let mut acc = 0.0;
    let mut zi = 0;
    for w in pts.windows(2) {
        let d = geo::haversine_m(w[0], w[1]);
        let mid = acc + d / 2.0;
        while zi + 1 < steps.len() && steps[zi].0 * scale < mid {
            zi += 1;
        }
        seg.push(steps.get(zi).and_then(|x| x.1));
        acc += d;
    }
    let (full, zones, offnet) = with_connectors(a, b, &pts, &seg, mode);
    let mut features = HashMap::new();
    features.insert("offnet_m".into(), offnet);
    features.insert("uturns".into(), steps.iter().filter(|x| x.2.contains("UTURN")).count() as f64);
    features.insert("ramps".into(), steps.iter().filter(|x| x.2.starts_with("RAMP") || x.2.starts_with("MERGE")).count() as f64);
    let dur = seconds(&route["duration"]);
    let stat = seconds(&route["staticDuration"]);
    Ok(RouteResult {
        points: full,
        provider: "google".into(),
        zones: Some(zones),
        ref_duration_s: Some(if dur > 0.0 { dur } else { stat }).filter(|x| *x > 0.0),
        features,
        notes: route["warnings"].as_array().into_iter().flatten().filter_map(|w| w.as_str().map(String::from)).collect(),
        exportable: false,
        kind: "main".into(),
    })
}

pub async fn google_tile_session(key: &str, map_type: &str, language: &str, region: &str) -> Result<Value, String> {
    let r = http()
        .post(format!("https://tile.googleapis.com/v1/createSession?key={key}"))
        .json(&json!({"mapType": map_type, "language": language, "region": region}))
        .send()
        .await
        .map_err(|e| format!("Could not reach Google ({e})"))?;
    let status = r.status().as_u16();
    let text = r.text().await.unwrap_or_default();
    let data: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if status != 200 {
        return Err(google_error(status, &data, &text).replace("API error", "Map Tiles API error"));
    }
    Ok(data)
}

pub async fn google_copyright(key: &str, session: &str, zoom: i64, n: f64, s: f64, e: f64, w: f64) -> String {
    let r = http()
        .get("https://tile.googleapis.com/tile/v1/viewport")
        .query(&[("session", session), ("key", key)])
        .query(&[("zoom", zoom)])
        .query(&[("north", n), ("south", s), ("east", e), ("west", w)])
        .send()
        .await;
    match r {
        Ok(r) if r.status().is_success() => r.json::<Value>().await.ok().and_then(|v| v["copyright"].as_str().map(String::from)).unwrap_or_default(),
        _ => String::new(),
    }
}

// ---------------------------------------------------------------- place search (Nominatim)
pub async fn geocode(query: &str, limit: usize) -> Result<Vec<Value>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let base = env_or("SPOOFER_NOMINATIM", "https://nominatim.openstreetmap.org");
    let r = http()
        .get(format!("{base}/search"))
        .query(&[("q", q), ("format", "jsonv2"), ("limit", &limit.to_string())])
        .send()
        .await
        .map_err(|e| format!("Place search failed: {e}"))?;
    if !r.status().is_success() {
        return Err(format!("Place search failed: HTTP {}", r.status().as_u16()));
    }
    let items: Vec<Value> = r.json().await.map_err(|e| format!("Place search failed: {e}"))?;
    Ok(items
        .iter()
        .filter_map(|it| {
            Some(json!({
                "name": it["display_name"].as_str().unwrap_or(""),
                "lat": it["lat"].as_str()?.parse::<f64>().ok()?,
                "lon": it["lon"].as_str()?.parse::<f64>().ok()?,
            }))
        })
        .collect())
}

// ---------------------------------------------------------------- sea lanes (embedded marine network)
struct SeaGraph {
    nodes: Vec<LatLon>,
    adj: Vec<Vec<(usize, f64)>>,
}

fn sea_graph() -> &'static SeaGraph {
    static G: OnceLock<SeaGraph> = OnceLock::new();
    G.get_or_init(|| {
        // Marine network from the `searoute` project (Apache-2.0), derived from Eurostat SeaRoute.
        let raw = include_str!("../data/marnet_searoute.geojson");
        let v: Value = serde_json::from_str(raw).expect("embedded sea network");
        let mut index: HashMap<(i64, i64), usize> = HashMap::new();
        let mut nodes: Vec<LatLon> = Vec::new();
        let mut adj: Vec<Vec<(usize, f64)>> = Vec::new();
        let mut node_id = |lat: f64, lon: f64, nodes: &mut Vec<LatLon>, adj: &mut Vec<Vec<(usize, f64)>>| -> usize {
            let lon_n = if (lon - (-180.0)).abs() < 1e-9 { 180.0 } else { lon };
            let key = ((lat * 1e6).round() as i64, (lon_n * 1e6).round() as i64);
            *index.entry(key).or_insert_with(|| {
                nodes.push((lat, lon_n));
                adj.push(Vec::new());
                nodes.len() - 1
            })
        };
        let mut lines: Vec<Vec<(f64, f64)>> = Vec::new();
        for f in v["features"].as_array().into_iter().flatten() {
            let g = &f["geometry"];
            let to_line = |arr: &Value| -> Vec<(f64, f64)> {
                arr.as_array().into_iter().flatten().filter_map(|p| Some((p[1].as_f64()?, p[0].as_f64()?))).collect()
            };
            match g["type"].as_str() {
                Some("LineString") => lines.push(to_line(&g["coordinates"])),
                Some("MultiLineString") => {
                    for l in g["coordinates"].as_array().into_iter().flatten() {
                        lines.push(to_line(l));
                    }
                }
                _ => {}
            }
        }
        for line in lines {
            for w in line.windows(2) {
                let i = node_id(w[0].0, w[0].1, &mut nodes, &mut adj);
                let j = node_id(w[1].0, w[1].1, &mut nodes, &mut adj);
                if i == j {
                    continue;
                }
                let d = geo::haversine_m(nodes[i], nodes[j]);
                adj[i].push((j, d));
                adj[j].push((i, d));
            }
        }
        SeaGraph { nodes, adj }
    })
}

pub fn sea_route(a: LatLon, b: LatLon) -> Result<Vec<LatLon>, String> {
    let g = sea_graph();
    let nearest = |p: LatLon| -> usize {
        let mut best = (f64::INFINITY, 0);
        for (i, n) in g.nodes.iter().enumerate() {
            if g.adj[i].is_empty() {
                continue;
            }
            let d = geo::haversine_m(p, *n);
            if d < best.0 {
                best = (d, i);
            }
        }
        best.1
    };
    let (s, t) = (nearest(a), nearest(b));
    #[derive(PartialEq)]
    struct St(f64, usize);
    impl Eq for St {}
    impl PartialOrd for St {
        fn partial_cmp(&self, o: &Self) -> Option<std::cmp::Ordering> {
            Some(self.cmp(o))
        }
    }
    impl Ord for St {
        fn cmp(&self, o: &Self) -> std::cmp::Ordering {
            o.0.partial_cmp(&self.0).unwrap_or(std::cmp::Ordering::Equal)
        }
    }
    let n = g.nodes.len();
    let mut dist = vec![f64::INFINITY; n];
    let mut prev = vec![usize::MAX; n];
    let mut heap = BinaryHeap::new();
    dist[s] = 0.0;
    heap.push(St(0.0, s));
    while let Some(St(d, u)) = heap.pop() {
        if u == t {
            break;
        }
        if d > dist[u] {
            continue;
        }
        for &(v, w) in &g.adj[u] {
            let nd = d + w;
            if nd < dist[v] {
                dist[v] = nd;
                prev[v] = u;
                heap.push(St(nd, v));
            }
        }
    }
    if !dist[t].is_finite() {
        return Err("No sea route found between these points".into());
    }
    let mut path = vec![t];
    let mut cur = t;
    while cur != s {
        cur = prev[cur];
        path.push(cur);
    }
    path.reverse();
    let mut out = vec![a];
    out.extend(path.into_iter().map(|i| (g.nodes[i].0, geo::wrap_lon(g.nodes[i].1))));
    out.push(b);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn polyline_reference() {
        let pts = decode_polyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@").unwrap();
        assert_eq!(pts, vec![(38.5, -120.2), (40.7, -120.95), (43.252, -126.453)]);
    }

    #[test]
    fn maxspeed() {
        assert_eq!(parse_maxspeed(Some("50")), Some(50.0));
        assert!((parse_maxspeed(Some("30 mph")).unwrap() - 48.28).abs() < 0.01);
        assert_eq!(parse_maxspeed(Some("DE:urban")), Some(50.0));
        assert_eq!(parse_maxspeed(Some("50;30")), Some(30.0));
        assert_eq!(parse_maxspeed(Some("none")), None);
        assert_eq!(parse_maxspeed(None), None);
    }

    #[test]
    fn sea_le_havre_to_new_york() {
        let r = sea_route((49.49, 0.10), (40.60, -74.03)).unwrap();
        let len = geo::polyline_length(&r) / 1000.0;
        // the Python searoute package gives ~5785 km for this pair
        assert!(len > 5300.0 && len < 6400.0, "{len}");
    }

    #[test]
    fn public_osrm_requests_are_one_second_apart() {
        let now = Instant::now();
        let mut next = None;
        let waits: Vec<Duration> = (0..3).map(|_| reserve_slot(&mut next, now, OSRM_MIN_INTERVAL)).collect();
        assert_eq!(waits, vec![Duration::ZERO, Duration::from_secs(1), Duration::from_secs(2)]);
        // once the slot has passed there is no wait
        assert_eq!(reserve_slot(&mut next, now + Duration::from_secs(10), OSRM_MIN_INTERVAL), Duration::ZERO);
        assert!(osrm_wait("http://localhost:5000").is_zero()); // your own server is not throttled
    }

    fn osrm_route(nodes: &[&[i64]], duration: f64, distance: f64, turn: Option<(f64, f64)>) -> Value {
        let legs: Vec<Value> = nodes
            .iter()
            .enumerate()
            .map(|(k, ns)| {
                let mut arrive = json!({"type": "arrive", "bearing_before": 90.0});
                let mut depart = json!({"type": "depart", "bearing_after": 90.0});
                if let Some((before, after)) = turn {
                    if k == 0 {
                        arrive["bearing_before"] = json!(before);
                    }
                    if k == 1 {
                        depart["bearing_after"] = json!(after);
                    }
                }
                json!({"annotation": {"speed": vec![10.0; ns.len() - 1], "nodes": ns},
                       "steps": [{"maneuver": depart}, {"maneuver": arrive}]})
            })
            .collect();
        json!({"duration": duration, "distance": distance, "legs": legs,
               "geometry": {"coordinates": [[-0.12, 51.5], [-0.11, 51.5], [-0.10, 51.5]]}})
    }

    #[test]
    fn detour_filters() {
        let main = parse_osrm(&osrm_route(&[&[1, 2, 3, 4]], 300.0, 3000.0, None), "main").unwrap();
        let taken = vec![main.pairs()];
        let good = parse_osrm(&osrm_route(&[&[1, 7, 8], &[8, 9, 4]], 360.0, 3600.0, None), "detour").unwrap();
        assert!(good.via_turn < 1.0 && good.nodes.len() == 2);
        assert!(detour_ok(&good, &main, &taken));
        let spike = parse_osrm(&osrm_route(&[&[1, 10], &[10, 4]], 340.0, 3300.0, Some((180.0, 0.0))), "detour").unwrap();
        assert!((spike.via_turn - 180.0).abs() < 1e-9 && !detour_ok(&spike, &main, &taken));
        let same = parse_osrm(&osrm_route(&[&[1, 2, 3], &[3, 4]], 310.0, 3050.0, None), "detour").unwrap();
        assert!(!detour_ok(&same, &main, &taken));
        let lap = parse_osrm(&osrm_route(&[&[1, 13, 14, 15], &[15, 14, 16, 4]], 330.0, 3300.0, None), "detour").unwrap();
        assert!(lap.doubles_back() && !detour_ok(&lap, &main, &taken)); // 14-15 driven out and back
        let rounded: Value = serde_json::from_str(r#"{"duration": 300, "distance": 3000,
            "geometry": {"coordinates": [[-0.12, 51.5], [-0.11, 51.5], [-0.10, 51.5], [-0.09, 51.5]]},
            "legs": [{"annotation": {"speed": [10, 10, 10], "nodes": [1, 1.134297535e+10, 1.134297535e+10, 4]}, "steps": []}]}"#).unwrap();
        let r = parse_osrm(&rounded, "detour").unwrap();
        assert_eq!(r.nodes[0], vec![1, UNKNOWN_NODE, UNKNOWN_NODE, 4]); // still lines up with the 3 speeds
        assert!(!r.doubles_back() && r.pairs().is_empty());
        let through = parse_osrm(&osrm_route(&[&[1, 17, 18], &[17, 18, 4]], 330.0, 3300.0, None), "detour").unwrap();
        assert!(!through.doubles_back()); // the via point's own segment ends leg 1 and starts leg 2
        let slow = parse_osrm(&osrm_route(&[&[1, 11], &[11, 4]], 1000.0, 3500.0, None), "detour").unwrap();
        assert!(!detour_ok(&slow, &main, &taken));
        let long = parse_osrm(&osrm_route(&[&[1, 12], &[12, 4]], 400.0, 9000.0, None), "detour").unwrap();
        assert!(!detour_ok(&long, &main, &taken));
    }

    #[test]
    fn reversals_spot_up_and_back_detours() {
        let a = (51.5, -0.12);
        let up: Vec<LatLon> = (0..=8).map(|k| geo::destination(a, 0.0, 100.0 * k as f64)).collect();
        let top = *up.last().unwrap();
        let across = geo::destination(top, 90.0, 40.0);
        let mut hook = up.clone();
        hook.push(across);
        hook.extend((1..=8).map(|k| geo::destination(across, 180.0, 100.0 * k as f64)));
        assert_eq!(reversals(&hook), 1);
        let mut corner = up.clone();
        corner.extend((1..=8).map(|k| geo::destination(top, 90.0, 100.0 * k as f64)));
        assert_eq!(reversals(&corner), 0);
        let samples = resample(&[a, geo::destination(a, 90.0, 1010.0)], 50.0);
        assert_eq!(samples.len(), 21);
        assert!((geo::haversine_m(samples[1], samples[2]) - 50.0).abs() < 0.01);
    }

    #[test]
    fn point_halfway_along_a_polyline() {
        let a = (51.5, -0.12);
        let b = geo::destination(a, 90.0, 1000.0);
        let c = geo::destination(b, 0.0, 1000.0);
        let m = point_at_fraction(&[a, b, c], 0.5);
        assert!(geo::haversine_m(m, b) < 0.5);
        assert!(geo::haversine_m(point_at_fraction(&[a, b, c], 0.25), geo::destination(a, 90.0, 500.0)) < 0.5);
    }

    #[test]
    fn road_info_concat() {
        let a = RoadInfo { limits: vec![Some(50.0), None], kinds: vec!["road", ""], coverage: 0.5, source: "x".into() };
        let b = RoadInfo { limits: vec![Some(30.0)], kinds: vec!["restricted"], coverage: 1.0, source: "x".into() };
        let c = RoadInfo::concat(&[a, b]);
        assert_eq!(c.limits, vec![Some(50.0), None, Some(30.0)]);
        assert_eq!(c.kinds, vec!["road", "", "restricted"]);
        assert!((c.coverage - 2.0 / 3.0).abs() < 1e-9);
    }

    #[tokio::test]
    async fn straight_and_short_legs_have_no_alternatives() {
        let mut budget = ViaBudget::default();
        let r = route_options((51.5, -0.12), (51.51, -0.12), "straight", "osrm", None, false, 3, &mut budget, &|_| {}).await.unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].kind, "main");
        assert_eq!(budget.left, MAX_VIA_REQUESTS);
    }

    #[test]
    fn connectors() {
        let a = (51.5, -0.12);
        let s1 = geo::destination(a, 0.0, 60.0);
        let s2 = geo::destination(s1, 90.0, 500.0);
        let (full, zones, off) = with_connectors(a, s2, &[s1, s2], &[Some(10.0)], "car");
        assert_eq!(full.len(), 4);
        assert!((off - 60.0).abs() < 1.0);
        assert!((zones[0].1.unwrap() - 15.0 / 3.6).abs() < 1e-9);
    }
}
