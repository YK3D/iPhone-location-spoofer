//! Routing providers: OSRM (OpenStreetMap), Google Routes API, sea lanes, straight lines,
//! plus place search and OpenStreetMap speed limits. Mirrors routing.py / google_api.py /
//! road_speed.py of the browser version.

use crate::geo::{self, LatLon};
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{BinaryHeap, HashMap};
use std::sync::OnceLock;

pub const USER_AGENT: &str = "LocationSpoofer-Standalone/0.1 (desktop app)";
const OFFNET_MIN_M: f64 = 25.0;
const OFFNET_CAP_KMH: f64 = 15.0;
const RESTRICTED_CAP_KMH: f64 = 20.0;

#[derive(Clone, Debug, Default)]
pub struct RouteResult {
    pub points: Vec<LatLon>,
    pub provider: String,
    pub zones: Option<Vec<(f64, Option<f64>)>>,
    pub ref_duration_s: Option<f64>,
    pub features: HashMap<String, f64>,
    pub notes: Vec<String>,
    pub exportable: bool,
}

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

pub async fn route(a: LatLon, b: LatLon, mode: &str, provider: &str, google_key: Option<&str>, road_data: bool) -> Result<RouteResult, String> {
    if !["car", "bike", "foot", "sea", "straight"].contains(&mode) {
        return Err(format!("Unknown travel mode '{mode}'"));
    }
    if mode == "straight" || geo::haversine_m(a, b) < 1.0 {
        return Ok(RouteResult { points: vec![a, b], provider: "straight".into(), exportable: true, ..Default::default() });
    }
    if mode == "sea" {
        let pts = tokio::task::spawn_blocking(move || sea_route(a, b)).await.map_err(|e| e.to_string())??;
        return Ok(RouteResult { points: pts, provider: "searoute".into(), exportable: true, ..Default::default() });
    }
    if provider == "google" {
        let key = google_key.ok_or("Google routing needs an API key (Settings > Google Maps)")?;
        return google_route(a, b, mode, key).await;
    }
    osrm_route(a, b, mode, road_data).await
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

async fn osrm_route(a: LatLon, b: LatLon, mode: &str, road_data: bool) -> Result<RouteResult, String> {
    let base = match mode {
        "car" => env_or("SPOOFER_OSRM_CAR", "https://routing.openstreetmap.de/routed-car"),
        "bike" => env_or("SPOOFER_OSRM_BIKE", "https://routing.openstreetmap.de/routed-bike"),
        _ => env_or("SPOOFER_OSRM_FOOT", "https://routing.openstreetmap.de/routed-foot"),
    };
    let url = format!(
        "{}/route/v1/driving/{:.6},{:.6};{:.6},{:.6}?overview=full&geometries=geojson&steps=true&annotations=speed,nodes",
        base.trim_end_matches('/'),
        a.1,
        a.0,
        b.1,
        b.0
    );
    let r = http().get(&url).send().await.map_err(|e| {
        format!("Could not reach the {mode} routing server ({e}). Check your internet connection, switch to Google routing, or use 'straight'.")
    })?;
    if r.status().as_u16() == 429 {
        return Err("The routing server is rate-limiting requests. Wait a moment and try again.".into());
    }
    let status = r.status();
    let data: Value = r.json().await.map_err(|_| format!("Routing server returned HTTP {}", status.as_u16()))?;
    if data["code"] != "Ok" || data["routes"].as_array().map(|x| x.is_empty()).unwrap_or(true) {
        return Err(format!("No {mode} route found: {}", data["message"].as_str().or(data["code"].as_str()).unwrap_or("unknown error")));
    }
    let rt = &data["routes"][0];
    let pts: Vec<LatLon> = rt["geometry"]["coordinates"]
        .as_array()
        .map(|c| c.iter().filter_map(|p| Some((p[1].as_f64()?, p[0].as_f64()?))).collect())
        .unwrap_or_default();
    if pts.len() < 2 {
        return Err("The routing server returned an empty route".into());
    }
    let mut speeds: Vec<Option<f64>> = Vec::new();
    let mut nodes: Vec<i64> = Vec::new();
    let mut uturns = 0.0;
    for leg in rt["legs"].as_array().into_iter().flatten() {
        for v in leg["annotation"]["speed"].as_array().into_iter().flatten() {
            speeds.push(v.as_f64().filter(|x| *x > 0.0));
        }
        for n in leg["annotation"]["nodes"].as_array().into_iter().flatten() {
            if let Some(n) = n.as_i64() {
                nodes.push(n);
            }
        }
        for st in leg["steps"].as_array().into_iter().flatten() {
            if st["maneuver"]["modifier"] == "uturn" {
                uturns += 1.0;
            }
        }
    }
    if speeds.len() != pts.len() - 1 {
        speeds = vec![None; pts.len() - 1];
    }
    let mut notes = Vec::new();
    let mut features: HashMap<String, f64> = HashMap::from([("uturns".into(), uturns)]);
    if road_data && mode == "car" && !nodes.is_empty() {
        match fetch_osm_roads(&nodes).await {
            Ok((limits, kinds, coverage, source)) if limits.len() == speeds.len() => {
                let (mut hw, mut rs) = (0.0, 0.0);
                for i in 0..speeds.len() {
                    let mut v = speeds[i];
                    if kinds[i] == "restricted" {
                        rs += 1.0;
                        let cap = RESTRICTED_CAP_KMH / 3.6;
                        v = Some(v.map(|x| x.min(cap)).unwrap_or(cap));
                    }
                    if kinds[i] == "highway" {
                        hw += 1.0;
                    }
                    if let Some(lim) = limits[i] {
                        let l = lim / 3.6;
                        v = Some(v.map(|x| x.min(l)).unwrap_or(l * 0.9));
                    }
                    speeds[i] = v;
                }
                features.insert("highway_segments".into(), hw);
                features.insert("restricted_segments".into(), rs);
                notes.push(format!("Speed limits known for {:.0}% of this leg ({source}).", coverage * 100.0));
            }
            Ok((_, _, _, source)) => notes.push(format!("Speed-limit data {source}.")),
            Err(e) => {
                tracing::info!("overpass failed: {e}");
                notes.push("Public speed-limit data (OpenStreetMap Overpass) was unavailable; used typical road speeds.".into());
            }
        }
    }
    let (full, zones, offnet) = with_connectors(a, b, &pts, &speeds, mode);
    features.insert("offnet_m".into(), offnet);
    Ok(RouteResult {
        points: full,
        provider: "osrm".into(),
        zones: Some(zones),
        ref_duration_s: rt["duration"].as_f64().filter(|d| *d > 0.0),
        features,
        notes,
        exportable: true,
    })
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

#[allow(clippy::type_complexity)]
async fn fetch_osm_roads(nodes: &[i64]) -> Result<(Vec<Option<f64>>, Vec<&'static str>, f64, String), String> {
    let n = nodes.len().saturating_sub(1);
    let mut limits = vec![None; n];
    let mut kinds = vec![""; n];
    if nodes.len() > 6000 {
        return Ok((limits, kinds, 0.0, "skipped (route too long for the public speed-limit service)".into()));
    }
    let url = env_or("SPOOFER_OVERPASS", "https://overpass-api.de/api/interpreter");
    let mut unique: Vec<i64> = Vec::new();
    for id in nodes {
        if !unique.contains(id) {
            unique.push(*id);
        }
    }
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
    let mut known = 0;
    for i in 0..n {
        if let Some(tags) = pair.get(&(nodes[i], nodes[i + 1])) {
            kinds[i] = classify(tags);
            limits[i] = parse_maxspeed(tags.get("maxspeed").and_then(|v| v.as_str()));
            if limits[i].is_some() {
                known += 1;
            }
        }
    }
    Ok((limits, kinds, known as f64 / n.max(1) as f64, "OpenStreetMap (Overpass)".into()))
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

async fn google_route(a: LatLon, b: LatLon, mode: &str, key: &str) -> Result<RouteResult, String> {
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
    let mask = "routes.duration,routes.staticDuration,routes.distanceMeters,routes.polyline.encodedPolyline,\
routes.legs.steps.distanceMeters,routes.legs.steps.staticDuration,routes.legs.steps.polyline.encodedPolyline,\
routes.legs.steps.navigationInstruction.maneuver,routes.warnings";
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
    let route = data["routes"].get(0).ok_or(format!("Google found no {mode} route between these points"))?;
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
