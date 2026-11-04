//! Local HTTP server for the UI: same JSON API as the browser version (server.py), so the
//! front end in ui/ is shared between both apps.

use crate::device::{DeviceManager, DriverKind};
use crate::player::{Devices, Player};
use crate::profile::{self, Leg, ProfileSettings, Ramp, Timeline, Waypoint};
use crate::{geo, gmaps_links, gpx, routing, store::Store, updater::Updater};
use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Multipart, Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use rust_embed::RustEmbed;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use tokio::sync::Mutex as AsyncMutex;

#[derive(RustEmbed)]
#[folder = "../ui/"]
struct Ui;

pub struct StoredTimeline {
    pub id: String,
    pub tl: Arc<Timeline>,
    pub name: String,
    pub waypoints: Vec<(f64, f64, String)>,
    pub exportable: bool,
}

pub struct AppState {
    pub devices: Devices,
    pub player: Arc<Player>,
    pub timelines: Mutex<VecDeque<StoredTimeline>>,
    pub store: Store,
    pub updater: Arc<Updater>,
    pub restart: tokio::sync::Notify,
    pub restart_requested: std::sync::atomic::AtomicBool,
}

pub type App = Arc<AppState>;

impl AppState {
    pub fn new(store: Store, updater: Updater) -> App {
        let devices: Devices = Arc::new(AsyncMutex::new(DeviceManager::default()));
        Arc::new(Self {
            player: Arc::new(Player::new(devices.clone())),
            devices,
            timelines: Mutex::new(VecDeque::new()),
            store,
            updater: Arc::new(updater),
            restart: tokio::sync::Notify::new(),
            restart_requested: std::sync::atomic::AtomicBool::new(false),
        })
    }

    fn keep(&self, tl: Timeline, name: String, waypoints: Vec<(f64, f64, String)>, exportable: bool) -> (String, Arc<Timeline>) {
        let id: String = (0..12).map(|_| format!("{:x}", rand::random::<u8>() % 16)).collect();
        let tl = Arc::new(tl);
        let mut q = self.timelines.lock().unwrap();
        q.push_back(StoredTimeline { id: id.clone(), tl: tl.clone(), name, waypoints, exportable });
        while q.len() > 20 {
            q.pop_front();
        }
        (id, tl)
    }

    fn get(&self, id: &str) -> Result<(Arc<Timeline>, String, Vec<(f64, f64, String)>, bool), ApiError> {
        self.timelines
            .lock()
            .unwrap()
            .iter()
            .find(|t| t.id == id)
            .map(|t| (t.tl.clone(), t.name.clone(), t.waypoints.clone(), t.exportable))
            .ok_or(ApiError(404, "That route is no longer in memory. Build it again.".into()))
    }
}

// ---------------------------------------------------------------- errors
pub struct ApiError(pub u16, pub String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (StatusCode::from_u16(self.0).unwrap_or(StatusCode::BAD_REQUEST), Json(json!({"detail": self.1}))).into_response()
    }
}
fn bad(e: impl Into<String>) -> ApiError {
    ApiError(400, e.into())
}
fn dev(e: impl Into<String>) -> ApiError {
    ApiError(409, e.into())
}
fn upstream(e: impl Into<String>) -> ApiError {
    ApiError(502, e.into())
}
type R = Result<Json<Value>, ApiError>;

// ---------------------------------------------------------------- router
pub fn router(app: App) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/static/{*path}", get(static_file))
        .route("/api/status", get(status))
        .route("/api/devices", get(devices))
        .route("/api/connect", post(connect))
        .route("/api/disconnect", post(disconnect))
        .route("/api/device/reveal-developer-mode", post(reveal))
        .route("/api/device/mount", post(mount))
        .route("/api/location/set", post(set_location))
        .route("/api/location/clear", post(clear_location))
        .route("/api/parse-coords", post(parse_coords))
        .route("/api/geocode", get(geocode))
        .route("/api/route/build", post(build_route))
        .route("/api/gpx/import", post(gpx_import))
        .route("/api/gpx/timeline", post(gpx_timeline))
        .route("/api/gpx/export/{tid}", get(gpx_export))
        .route("/api/player/load/{tid}", post(player_load))
        .route("/api/player/{action}", post(player_action))
        .route("/api/player-seek", post(player_seek))
        .route("/api/player-options", post(player_options))
        .route("/api/joystick", post(joystick))
        .route("/api/update", get(update_status))
        .route("/api/update/check", post(update_check))
        .route("/api/update/install", post(update_install))
        .route("/api/tunneld/start", post(tunneld))
        .route("/api/links/parse", post(parse_link))
        .route("/api/google/status", get(google_status))
        .route("/api/google/tile-session", post(google_tile_session))
        .route("/api/google/copyright", get(google_copyright))
        .route("/api/store", get(store_get).put(store_put))
        .route("/api/app/quit", post(app_quit))
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        .layer(axum::middleware::from_fn(local_only))
        .with_state(app)
}

/// Only answer the app's own window: blocks other websites (cross-site requests) and
/// DNS-rebinding pages from using the local API.
async fn local_only(req: axum::extract::Request, next: axum::middleware::Next) -> Response {
    let ok = {
        let h = req.headers();
        let get = |n: header::HeaderName| h.get(n).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        let host = get(header::HOST);
        let origin = get(header::ORIGIN);
        let host_ok = ["127.0.0.1", "localhost"]
            .iter()
            .any(|n| host == *n || host.strip_prefix(n).is_some_and(|r| r.starts_with(':')));
        host_ok && (origin.is_empty() || origin == format!("http://{host}"))
    };
    if !ok {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    next.run(req).await
}

/// Lets a newer copy of the app close an older one that still holds the port.
async fn app_quit() -> R {
    tokio::spawn(async {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        std::process::exit(0);
    });
    Ok(Json(json!({"ok": true})))
}

async fn index() -> Response {
    static_response("index.html")
}

async fn static_file(Path(path): Path<String>) -> Response {
    static_response(&path)
}

fn static_response(path: &str) -> Response {
    match Ui::get(path) {
        Some(f) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            Response::builder()
                .header(header::CONTENT_TYPE, mime.as_ref())
                .header(header::CACHE_CONTROL, "no-cache")
                .body(Body::from(f.data.into_owned()))
                .unwrap()
        }
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

// ---------------------------------------------------------------- device
async fn status(State(app): State<App>) -> R {
    let d = app.devices.lock().await;
    Ok(Json(json!({
        "version": crate::updater::current_version(),
        "app": "standalone",
        "driver": d.kind.key(),
        "drivers": [{"key": "pmd3", "label": "Direct", "live": true}, {"key": "mock", "label": "Simulator (no iPhone)", "live": true}],
        "features": {"cli_driver": false, "tunnel_helper": false},
        "device": d.info(),
        "live": true,
        "player": app.player.status(),
        "update": app.updater.status(),
    })))
}

#[derive(Deserialize)]
struct DriverQ {
    driver: Option<String>,
}

async fn devices(State(app): State<App>, Query(q): Query<DriverQ>) -> R {
    let kind = DriverKind::parse(q.driver.as_deref().unwrap_or("pmd3")).ok_or(bad("unknown driver"))?;
    let list = app.devices.lock().await.list_devices(kind).await.map_err(dev)?;
    Ok(Json(json!({"devices": list})))
}

#[derive(Deserialize)]
struct ConnectIn {
    driver: Option<String>,
    udid: Option<String>,
}

async fn connect(State(app): State<App>, Json(b): Json<ConnectIn>) -> R {
    let kind = DriverKind::parse(b.driver.as_deref().unwrap_or("pmd3")).ok_or(bad("unknown driver"))?;
    app.player.stop().await;
    let info = app.devices.lock().await.connect(kind, b.udid.filter(|s| !s.is_empty())).await.map_err(dev)?;
    Ok(Json(json!({"device": info})))
}

async fn disconnect(State(app): State<App>) -> R {
    app.player.stop().await;
    app.devices.lock().await.disconnect().await;
    Ok(Json(json!({"ok": true})))
}

async fn reveal(State(app): State<App>) -> R {
    let m = app.devices.lock().await.reveal_developer_mode().await.map_err(dev)?;
    Ok(Json(json!({"message": m})))
}

async fn mount(State(app): State<App>) -> R {
    let m = app.devices.lock().await.mount_developer_image().await.map_err(dev)?;
    Ok(Json(json!({"message": m})))
}

// ---------------------------------------------------------------- location
#[derive(Deserialize)]
struct LatLonIn {
    lat: f64,
    lon: f64,
}

async fn set_location(State(app): State<App>, Json(b): Json<LatLonIn>) -> R {
    geo::validate_latlon(b.lat, b.lon).map_err(bad)?;
    Ok(Json(app.player.teleport(b.lat, b.lon).await.map_err(dev)?))
}

async fn clear_location(State(app): State<App>) -> R {
    app.player.clear().await.map_err(dev)?;
    Ok(Json(json!({"ok": true})))
}

#[derive(Deserialize)]
struct TextIn {
    text: String,
}

async fn parse_coords(Json(b): Json<TextIn>) -> R {
    let (lat, lon) = geo::parse_coordinates(&b.text).map_err(bad)?;
    Ok(Json(json!({"lat": lat, "lon": lon})))
}

#[derive(Deserialize)]
struct GeoQ {
    q: String,
}

async fn geocode(Query(q): Query<GeoQ>) -> R {
    Ok(Json(json!({"results": routing::geocode(&q.q, 6).await.map_err(upstream)?})))
}

// ---------------------------------------------------------------- routes
fn d_true() -> bool {
    true
}
fn d_one() -> f64 {
    1.0
}
fn d_five() -> f64 {
    5.0
}
fn d_two() -> f64 {
    2.0
}

#[derive(Deserialize, Clone)]
struct SettingsIn {
    #[serde(default = "d_five")]
    default_cruise_kmh: f64,
    #[serde(default = "d_one")]
    accel_ms2: f64,
    #[serde(default = "d_one")]
    decel_ms2: f64,
    #[serde(default = "d_true")]
    start_from_rest: bool,
    #[serde(default = "d_true")]
    stop_at_end: bool,
    #[serde(default)]
    road_aware: bool,
    #[serde(default)]
    road_data: bool,
    #[serde(default = "d_true")]
    match_eta: bool,
    #[serde(default = "d_one")]
    speed_factor: f64,
    #[serde(default)]
    corner_slowdown: bool,
    #[serde(default = "d_two")]
    lateral_accel_ms2: f64,
}

impl Default for SettingsIn {
    fn default() -> Self {
        serde_json::from_value(json!({})).unwrap()
    }
}

impl SettingsIn {
    fn validate(&self) -> Result<(), ApiError> {
        let ok = self.default_cruise_kmh > 0.0
            && self.default_cruise_kmh <= 5000.0
            && self.accel_ms2 > 0.0
            && self.accel_ms2 <= 100.0
            && self.decel_ms2 > 0.0
            && self.decel_ms2 <= 100.0
            && self.speed_factor > 0.1
            && self.speed_factor <= 3.0
            && self.lateral_accel_ms2 > 0.1
            && self.lateral_accel_ms2 <= 10.0;
        if ok { Ok(()) } else { Err(ApiError(422, "settings: a value is out of range".into())) }
    }
    fn profile(&self) -> ProfileSettings {
        ProfileSettings {
            default_cruise_kmh: self.default_cruise_kmh,
            accel_ms2: self.accel_ms2,
            decel_ms2: self.decel_ms2,
            start_from_rest: self.start_from_rest,
            stop_at_end: self.stop_at_end,
            road_aware: self.road_aware,
            speed_factor: self.speed_factor,
            corner_slowdown: self.corner_slowdown || self.road_aware,
            lateral_accel_ms2: self.lateral_accel_ms2,
            ..Default::default()
        }
    }
}

#[derive(Deserialize, Clone)]
struct WaypointIn {
    lat: f64,
    lon: f64,
    name: Option<String>,
    speed_kmh: Option<f64>,
    #[serde(default)]
    dwell_s: f64,
    /// stop here until the user presses Continue
    #[serde(default)]
    hold: bool,
}

#[derive(Deserialize, Clone)]
struct LegIn {
    #[serde(default = "foot")]
    mode: String,
    cruise_kmh: Option<f64>,
    #[serde(default = "accel")]
    ramp: String,
}
fn foot() -> String {
    "foot".into()
}
fn accel() -> String {
    "accel".into()
}

#[derive(Deserialize)]
struct RouteIn {
    #[serde(default = "route_name")]
    name: String,
    waypoints: Vec<WaypointIn>,
    legs: Vec<LegIn>,
    #[serde(default)]
    settings: SettingsIn,
    #[serde(default)]
    closed: bool,
    #[serde(default = "osrm")]
    provider: String,
    /// extra route options to look for (0-3)
    #[serde(default)]
    alternatives: usize,
}
fn route_name() -> String {
    "Route".into()
}
fn osrm() -> String {
    "osrm".into()
}

fn payload(id: &str, tl: &Timeline, legs: Value, extra: Value, providers: Value, exportable: bool) -> Value {
    let interval = (tl.duration() / 4000.0).max(1.0);
    let preview: Vec<Value> = tl
        .sample(interval, 0.0)
        .iter()
        // [t s, lat, lon, speed km/h, distance along the route m]
        .map(|p| json!([(p.t * 100.0).round() / 100.0, p.lat, p.lon, (p.speed_ms * 3.6 * 100.0).round() / 100.0, (p.distance_m * 10.0).round() / 10.0]))
        .collect();
    let mut summary = tl.summary();
    if let (Some(s), Some(e)) = (summary.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            s.insert(k.clone(), v.clone());
        }
    }
    json!({"id": id, "summary": summary, "legs": legs, "preview": preview, "providers": providers, "exportable": exportable})
}

/// Stage reports while a route builds: (fraction done, message, fraction expected at the end of
/// this stage). The UI animates its bar from the first towards the third while a stage runs.
type Progress = Arc<dyn Fn(f64, &str, f64) + Send + Sync>;
const OPTION_LABELS: [&str; 4] = ["A", "B", "C", "D"];

fn leg_verb(mode: &str, provider: &str) -> &'static str {
    if provider == "google" && ["car", "bike", "foot"].contains(&mode) {
        return "Asking Google Maps for the route";
    }
    match mode {
        "car" => "Finding the best road route",
        "bike" => "Finding cycle paths",
        "foot" => "Finding footpaths",
        "sea" => "Plotting sea lanes",
        _ => "Drawing a straight line",
    }
}

fn check_route_in(b: &RouteIn) -> Result<(), ApiError> {
    b.settings.validate()?;
    if b.waypoints.len() < 2 || b.waypoints.len() > 500 {
        return Err(ApiError(422, "waypoints: need 2 to 500 checkpoints".into()));
    }
    if b.alternatives > routing::MAX_ALTERNATIVES {
        return Err(ApiError(422, format!("alternatives: 0 to {}", routing::MAX_ALTERNATIVES)));
    }
    Ok(())
}

/// Route every leg (plus alternatives), then solve one timeline per route option.
async fn build_route_core(app: App, mut b: RouteIn, progress: Progress) -> Result<Value, ApiError> {
    check_route_in(&b)?;
    let n_checkpoints = b.waypoints.len();
    if b.closed {
        let f = b.waypoints[0].clone();
        b.waypoints.push(WaypointIn { lat: f.lat, lon: f.lon, name: Some(format!("{} (return)", f.name.unwrap_or("Start".into()))), speed_kmh: None, dwell_s: 0.0, hold: false });
        if b.legs.len() == b.waypoints.len() - 2 {
            let last = b.legs.last().cloned().unwrap_or(LegIn { mode: foot(), cruise_kmh: None, ramp: accel() });
            b.legs.push(last);
        }
    }
    if b.legs.len() != b.waypoints.len() - 1 {
        return Err(bad(format!("Expected {} legs, got {}", b.waypoints.len() - 1, b.legs.len())));
    }
    for w in &b.waypoints {
        geo::validate_latlon(w.lat, w.lon).map_err(bad)?;
        if w.dwell_s < 0.0 || w.dwell_s > 86400.0 || w.speed_kmh.map(|s| !(0.0..=5000.0).contains(&s)).unwrap_or(false) {
            return Err(ApiError(422, "waypoint speed or wait is out of range".into()));
        }
    }
    let key = if b.provider == "google" {
        Some(app.store.google_key().ok_or(bad("Google routing needs your Google Maps API key (Settings)."))?)
    } else {
        None
    };
    let n = b.legs.len();
    progress(0.01, &format!("Checking {n_checkpoints} checkpoints"), 0.03);
    let mut budget = routing::ViaBudget::default();
    let mut leg_options: Vec<Vec<routing::RouteResult>> = Vec::with_capacity(n);
    // Option k uses alternative k on every leg that has one, so one leg with enough alternatives is
    // enough: once some leg has them, later legs skip the (slow) detour search.
    let mut best = 0;
    for (i, li) in b.legs.iter().enumerate() {
        let a = (b.waypoints[i].lat, b.waypoints[i].lon);
        let c = (b.waypoints[i + 1].lat, b.waypoints[i + 1].lon);
        let (p0, p1) = (0.03 + 0.72 * i as f64 / n as f64, 0.03 + 0.72 * (i + 1) as f64 / n as f64);
        let suffix = if n > 1 { format!(" · leg {} of {n}", i + 1) } else { String::new() };
        progress(p0, &format!("{}{suffix}", leg_verb(&li.mode, &b.provider)), p1);
        let sub = |m: &str| progress(p0, &format!("{m}{suffix}"), p1);
        let opts = routing::route_options(
            a,
            c,
            &li.mode,
            &b.provider,
            key.as_deref(),
            b.settings.road_aware && b.settings.road_data,
            b.alternatives,
            &mut budget,
            &sub,
            best < b.alternatives,
        )
        .await
        .map_err(|e| upstream(format!("Leg {} ({}): {e}", i + 1, li.mode)))?;
        best = best.max(opts.len().saturating_sub(1));
        leg_options.push(opts);
    }
    let wps: Vec<Waypoint> = b.waypoints.iter().map(|w| Waypoint { lat: w.lat, lon: w.lon, speed_kmh: w.speed_kmh, dwell_s: w.dwell_s, hold: w.hold }).collect();
    let names: Vec<(f64, f64, String)> = b.waypoints.iter().enumerate().map(|(i, w)| (w.lat, w.lon, w.name.clone().unwrap_or(format!("Checkpoint {}", i + 1)))).collect();
    let prof = b.settings.profile();
    let n_opts = leg_options.iter().map(|o| o.len()).max().unwrap_or(1);
    struct Built {
        tl: Timeline,
        geometry: Vec<Vec<Value>>,
        providers: Vec<String>,
        exportable: bool,
        changed_legs: Vec<usize>,
        detour: bool,
        extra: Value,
    }
    let mut built: Vec<Built> = Vec::with_capacity(n_opts);
    for j in 0..n_opts {
        let chosen: Vec<&routing::RouteResult> = leg_options.iter().map(|o| o.get(j).unwrap_or(&o[0])).collect();
        let mut legs = Vec::new();
        let mut geometry = Vec::new();
        let mut providers = Vec::new();
        let mut notes = Vec::new();
        let mut features: HashMap<String, f64> = HashMap::new();
        let (mut ref_total, mut ref_complete, mut exportable) = (0.0, true, true);
        for (i, (li, res)) in b.legs.iter().zip(&chosen).enumerate() {
            let mut leg = Leg::new(res.points.clone());
            leg.cruise_kmh = li.cruise_kmh.filter(|v| *v > 0.0);
            leg.ramp = if li.ramp == "linear" { Ramp::Linear } else { Ramp::Accel };
            leg.zones = res.zones.clone();
            leg.mode = li.mode.clone();
            leg.roundabouts = res.roundabouts.clone();
            legs.push(leg);
            geometry.push(res.points.iter().map(|p| json!([p.0, p.1])).collect::<Vec<_>>());
            providers.push(res.provider.clone());
            notes.extend(res.notes.iter().map(|nt| format!("Leg {}: {nt}", i + 1)));
            for (k, v) in &res.features {
                *features.entry(k.clone()).or_insert(0.0) += v;
            }
            exportable &= res.exportable;
            match res.ref_duration_s {
                Some(r) => ref_total += r,
                None if li.mode != "straight" || n == 1 => ref_complete = false,
                None => {}
            }
        }
        let (q0, q1) = (0.76 + 0.2 * j as f64 / n_opts as f64, 0.76 + 0.2 * (j + 1) as f64 / n_opts as f64);
        let which = if n_opts > 1 { format!(" · route {} of {n_opts}", j + 1) } else { String::new() };
        if prof.corner_slowdown {
            progress(q0, &format!("Identifying turns and U-turns{which}"), q0 + (q1 - q0) * 0.3);
        }
        let source = if providers.iter().any(|p| p == "google") { "Google" } else { "OSRM" };
        let match_eta = b.settings.road_aware && b.settings.match_eta && ref_complete && ref_total > 0.0;
        let msg = if match_eta {
            format!("Matching the {source} ETA with your driving style")
        } else if b.settings.road_aware {
            format!("Applying your driving style ({:.0}%)", prof.speed_factor * 100.0)
        } else {
            "Applying acceleration and braking".to_string()
        };
        progress(q0 + (q1 - q0) * 0.3, &format!("{msg}{which}"), q0 + (q1 - q0) * 0.8);
        let (w2, l2, p2) = (wps.clone(), legs, prof.clone());
        let (tl, factor) = tokio::task::spawn_blocking(move || -> Result<(Timeline, f64), String> {
            if match_eta {
                profile::build_matching_eta(&w2, &l2, &p2, ref_total)
            } else {
                Ok((profile::build_timeline(&w2, &l2, &p2)?, p2.speed_factor))
            }
        })
        .await
        .map_err(|e| ApiError(500, format!("Building the route failed: {e}")))?
        .map_err(bad)?;
        progress(q0 + (q1 - q0) * 0.8, &format!("Calculating the ETA{which}"), q1);
        let extra = json!({
            "reference_eta_s": (ref_complete && ref_total > 0.0).then(|| (ref_total * 10.0).round() / 10.0),
            "reference_source": if providers.iter().any(|p| p == "google") { Some("Google") } else if providers.iter().any(|p| p == "osrm") { Some("OSRM") } else { None },
            "speed_factor": (factor * 1000.0).round() / 1000.0,
            "features": features,
            "notes": notes,
            "road_aware": b.settings.road_aware,
        });
        built.push(Built {
            tl,
            geometry,
            providers,
            exportable,
            changed_legs: leg_options.iter().enumerate().filter(|(_, o)| j > 0 && j < o.len()).map(|(i, _)| i).collect(),
            detour: chosen.iter().any(|r| r.kind == "detour"),
            extra,
        });
    }
    // Route A is the routing service's main route; the alternatives follow, quickest first.
    built[1..].sort_by(|x, y| x.tl.duration().partial_cmp(&y.tl.duration()).unwrap_or(std::cmp::Ordering::Equal));
    let mut results: Vec<Value> = Vec::with_capacity(built.len());
    for (rank, o) in built.into_iter().enumerate() {
        let label = OPTION_LABELS[rank];
        let name = if rank == 0 { b.name.clone() } else { format!("{} ({label})", b.name) };
        let (id, tl) = app.keep(o.tl, name, names.clone(), o.exportable);
        let mut v = payload(&id, &tl, json!(o.geometry), o.extra, json!(o.providers), o.exportable);
        v["option"] = json!({"index": rank, "label": label, "changed_legs": o.changed_legs, "detour": o.detour});
        results.push(v);
    }
    let mut top = results.remove(0);
    top["alternatives"] = json!(results);
    top["alternatives_requested"] = json!(b.alternatives);
    Ok(top)
}

#[derive(Deserialize)]
struct BuildQ {
    stream: Option<String>,
}

/// Without `stream` the response is the route as JSON. With `?stream=1` it is NDJSON:
/// {"type": "progress", "p", "next", "msg"} lines, then one {"type": "result", "data"} or
/// {"type": "error", "status", "detail"} line.
async fn build_route(State(app): State<App>, Query(q): Query<BuildQ>, Json(b): Json<RouteIn>) -> Response {
    let stream = matches!(q.stream.as_deref(), Some("1" | "true" | "yes"));
    if !stream {
        let quiet: Progress = Arc::new(|_, _, _| {});
        return match build_route_core(app, b, quiet).await {
            Ok(v) => Json(v).into_response(),
            Err(e) => e.into_response(),
        };
    }
    if let Err(e) = check_route_in(&b) {
        return e.into_response(); // bad requests fail fast, like the browser version's validation
    }
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let ptx = tx.clone();
    let r3 = |x: f64| (x * 1000.0).round() / 1000.0;
    let progress: Progress = Arc::new(move |p, msg, next| {
        let _ = ptx.send(json!({"type": "progress", "p": r3(p), "next": r3(next.max(p)), "msg": msg}));
    });
    let task = tokio::spawn(async move {
        let line = match build_route_core(app, b, progress).await {
            Ok(v) => json!({"type": "result", "data": v}),
            Err(ApiError(status, detail)) => json!({"type": "error", "status": status, "detail": detail}),
        };
        let _ = tx.send(line);
    });
    // Closing the window mid-build drops the stream, which stops the build.
    struct AbortOnDrop(tokio::task::JoinHandle<()>);
    impl Drop for AbortOnDrop {
        fn drop(&mut self) {
            self.0.abort();
        }
    }
    let lines = futures_util::stream::unfold((rx, AbortOnDrop(task)), |(mut rx, guard)| async move {
        rx.recv().await.map(|v| (Ok::<_, std::convert::Infallible>(format!("{v}\n")), (rx, guard)))
    });
    Response::builder()
        .header(header::CONTENT_TYPE, "application/x-ndjson")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from_stream(lines))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn gpx_import(mut mp: Multipart) -> R {
    while let Some(field) = mp.next_field().await.map_err(|e| bad(e.to_string()))? {
        if field.name() != Some("file") {
            continue;
        }
        let filename = field.file_name().unwrap_or("upload.gpx").to_string();
        let data = field.bytes().await.map_err(|e| bad(e.to_string()))?;
        if data.len() > 20 * 1024 * 1024 {
            return Err(ApiError(413, "GPX file is larger than 20 MB".into()));
        }
        let text = String::from_utf8_lossy(&data);
        let tracks = gpx::parse_gpx(text.trim_start_matches('\u{feff}')).map_err(bad)?;
        let out: Vec<Value> = tracks
            .iter()
            .map(|tr| {
                let t0 = tr.points.iter().find_map(|p| p.time);
                json!({
                    "name": tr.name, "kind": tr.kind, "timed": tr.timed(),
                    "points": tr.points.iter().map(|p| json!([p.lat, p.lon,
                        match (p.time, t0) { (Some(t), Some(t0)) => Some((t - t0).num_milliseconds() as f64 / 1000.0), _ => None }])).collect::<Vec<_>>(),
                    "names": tr.points.iter().map(|p| p.name.clone()).collect::<Vec<_>>(),
                })
            })
            .collect();
        return Ok(Json(json!({"filename": filename, "tracks": out})));
    }
    Err(bad("No file uploaded"))
}

#[derive(Deserialize)]
struct TrackIn {
    #[serde(default = "track_name")]
    name: String,
    points: Vec<(f64, f64, Option<f64>)>,
    #[serde(default = "d_true")]
    use_times: bool,
    #[serde(default)]
    reverse: bool,
    #[serde(default = "d_five")]
    cruise_kmh: f64,
    #[serde(default)]
    settings: SettingsIn,
}
fn track_name() -> String {
    "Imported track".into()
}

async fn gpx_timeline(State(app): State<App>, Json(b): Json<TrackIn>) -> R {
    b.settings.validate()?;
    if b.points.is_empty() || b.points.len() > 500_000 || !(b.cruise_kmh > 0.0 && b.cruise_kmh <= 5000.0) {
        return Err(ApiError(422, "points or speed out of range".into()));
    }
    for (lat, lon, _) in &b.points {
        geo::validate_latlon(*lat, *lon).map_err(bad)?;
    }
    let mut pts = b.points.clone();
    let timed = pts.len() > 1 && pts.iter().all(|p| p.2.is_some());
    if b.reverse {
        if timed {
            let end = pts.iter().filter_map(|p| p.2).fold(f64::MIN, f64::max);
            pts = pts.iter().rev().map(|(la, lo, t)| (*la, *lo, t.map(|t| end - t))).collect();
        } else {
            pts.reverse();
        }
    }
    let tl = if b.use_times && timed {
        if pts.windows(2).any(|w| w[1].2 < w[0].2) {
            return Err(bad("The GPX timestamps are not in order; untick 'Use the file's timestamps'."));
        }
        profile::timeline_from_timed_points(&pts.iter().map(|(la, lo, t)| (t.unwrap(), *la, *lo)).collect::<Vec<_>>()).map_err(bad)?
    } else {
        if pts.len() < 2 {
            return Err(bad("Need at least two points to make a route"));
        }
        let ends = [Waypoint::at((pts[0].0, pts[0].1)), Waypoint::at((pts[pts.len() - 1].0, pts[pts.len() - 1].1))];
        let mut leg = Leg::new(pts.iter().map(|p| (p.0, p.1)).collect());
        leg.cruise_kmh = Some(b.cruise_kmh);
        profile::build_timeline(&ends, &[leg], &b.settings.profile()).map_err(bad)?
    };
    let geometry = json!([pts.iter().map(|p| json!([p.0, p.1])).collect::<Vec<_>>()]);
    let (id, tl) = app.keep(tl, b.name.clone(), vec![], true);
    Ok(Json(payload(&id, &tl, geometry, json!({}), json!(["gpx"]), true)))
}

#[derive(Deserialize)]
struct ExportQ {
    interval: Option<f64>,
}

async fn gpx_export(State(app): State<App>, Path(tid): Path<String>, Query(q): Query<ExportQ>) -> Result<Response, ApiError> {
    let interval = q.interval.unwrap_or(1.0);
    if !(0.2..=60.0).contains(&interval) {
        return Err(bad("interval must be 0.2-60 s"));
    }
    let (tl, name, wps, exportable) = app.get(&tid)?;
    if !exportable {
        return Err(ApiError(
            403,
            "Routes from Google cannot be saved as GPX (Google's terms restrict storing Routes API content). \
             Switch the route to OpenStreetMap routing to export it."
                .into(),
        ));
    }
    if tl.duration() / interval > 1_000_000.0 {
        return Err(bad("That would be more than a million points; use a larger interval."));
    }
    let text = gpx::write_gpx(&tl.sample(interval, 0.0), &name, &wps);
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, "application/gpx+xml")
        .header(header::CONTENT_DISPOSITION, format!("attachment; filename=\"{}.gpx\"", gpx::safe_filename(&name)))
        .body(Body::from(text))
        .unwrap())
}

// ---------------------------------------------------------------- player
async fn player_load(State(app): State<App>, Path(tid): Path<String>) -> R {
    let (tl, name, _, _) = app.get(&tid)?;
    app.player.load(tl, name).await;
    Ok(Json(app.player.status()))
}

async fn player_action(State(app): State<App>, Path(action): Path<String>) -> R {
    match action.as_str() {
        "play" => app.player.play().await.map_err(dev)?,
        "pause" => app.player.pause().await,
        "resume" => app.player.resume().await.map_err(dev)?,
        "continue" => app.player.continue_().await.map_err(dev)?,
        "stop" => app.player.stop().await,
        "unload" => app.player.unload().await,
        _ => return Err(ApiError(404, "unknown action".into())),
    }
    Ok(Json(app.player.status()))
}

#[derive(Deserialize)]
struct SeekIn {
    t: f64,
}

async fn player_seek(State(app): State<App>, Json(b): Json<SeekIn>) -> R {
    app.player.seek(b.t).await.map_err(dev)?;
    Ok(Json(app.player.status()))
}

#[derive(Deserialize)]
struct OptionsIn {
    multiplier: Option<f64>,
    #[serde(rename = "loop")]
    loop_mode: Option<String>,
    jitter_m: Option<f64>,
    tick_s: Option<f64>,
    /// laps in loop / back-and-forth mode, 0 = no limit
    lap_limit: Option<i64>,
}

async fn player_options(State(app): State<App>, Json(b): Json<OptionsIn>) -> R {
    app.player.set_options(b.multiplier, b.loop_mode, b.jitter_m, b.tick_s, b.lap_limit).map_err(bad)?;
    Ok(Json(app.player.status()))
}

#[derive(Deserialize)]
struct JoyIn {
    moving: bool,
    bearing: Option<f64>,
    speed_kmh: Option<f64>,
}

async fn joystick(State(app): State<App>, Json(b): Json<JoyIn>) -> R {
    app.player.joystick(b.moving, b.bearing, b.speed_kmh).await.map_err(dev)?;
    Ok(Json(app.player.status()))
}

// ---------------------------------------------------------------- updates / misc
async fn update_status(State(app): State<App>) -> R {
    let mut s = app.updater.status();
    s["staged"] = json!(if app.updater.enabled { app.updater.staged_version() } else { None });
    Ok(Json(s))
}

pub fn update_channel(app: &AppState) -> String {
    app.store.load()["settings"]["update_channel"].as_str().unwrap_or("stable").to_string()
}

async fn update_check(State(app): State<App>) -> R {
    let channel = update_channel(&app);
    Ok(Json(app.updater.check(&channel).await))
}

async fn update_install(State(app): State<App>) -> R {
    if !app.updater.enabled {
        return Err(bad("Updates are installed by the Microsoft Store / your package manager for this build."));
    }
    if app.updater.staged_version().is_none() {
        return Err(dev("No downloaded update is ready. Press 'Check for updates' first."));
    }
    app.player.stop().await;
    if !app.updater.swap_in_staged().map_err(|e| ApiError(500, e))? {
        return Err(ApiError(500, "Could not install the update".into()));
    }
    app.restart_requested.store(true, std::sync::atomic::Ordering::SeqCst);
    let a = app.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        a.restart.notify_waiters();
    });
    Ok(Json(json!({"restarting": true})))
}

async fn tunneld() -> R {
    Err(bad(
        "Not needed in the standalone app: it opens its own tunnel without administrator rights on iOS 17.4 and newer. \
         iOS 17.0–17.3 is not supported here; update the iPhone or use the browser version.",
    ))
}

#[derive(Deserialize)]
struct LinkIn {
    text: String,
}

async fn parse_link(Json(b): Json<LinkIn>) -> R {
    if b.text.len() > 4000 {
        return Err(bad("Link is too long"));
    }
    let client = gmaps_links::no_redirect_client();
    let mut parsed = gmaps_links::parse_any(&b.text, &client).await.map_err(bad)?;
    let mut first = true;
    for st in parsed.stops.iter_mut().filter(|s| s.lat.is_none()) {
        if !first {
            tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
        }
        first = false;
        let res = routing::geocode(&st.query, 1).await.map_err(upstream)?;
        let r = res.first().ok_or(ApiError(404, format!("Could not find '{}' on the map", st.query)))?;
        st.lat = r["lat"].as_f64();
        st.lon = r["lon"].as_f64();
        if st.name.is_empty() {
            st.name = r["name"].as_str().unwrap_or("").into();
        }
    }
    Ok(Json(serde_json::to_value(parsed).unwrap()))
}

async fn google_status(State(app): State<App>) -> R {
    Ok(Json(json!({"configured": app.store.google_key().is_some()})))
}

#[derive(Deserialize)]
struct TileIn {
    map_type: Option<String>,
    language: Option<String>,
    region: Option<String>,
}

async fn google_tile_session(State(app): State<App>, Json(b): Json<TileIn>) -> R {
    let key = app.store.google_key().ok_or(bad("Add your Google Maps API key in Settings first."))?;
    let s = routing::google_tile_session(
        &key,
        b.map_type.as_deref().unwrap_or("roadmap"),
        b.language.as_deref().unwrap_or("en-US"),
        b.region.as_deref().unwrap_or("US"),
    )
    .await
    .map_err(upstream)?;
    Ok(Json(json!({"session": s["session"], "expiry": s["expiry"], "key": key, "tile_size": s["tileWidth"]})))
}

#[derive(Deserialize)]
struct CopyQ {
    session: String,
    zoom: i64,
    north: f64,
    south: f64,
    east: f64,
    west: f64,
}

async fn google_copyright(State(app): State<App>, Query(q): Query<CopyQ>) -> R {
    let Some(key) = app.store.google_key() else { return Ok(Json(json!({"copyright": ""}))) };
    Ok(Json(json!({"copyright": routing::google_copyright(&key, &q.session, q.zoom, q.north, q.south, q.east, q.west).await})))
}

async fn store_get(State(app): State<App>) -> R {
    Ok(Json(app.store.load()))
}

async fn store_put(State(app): State<App>, Json(b): Json<Value>) -> R {
    Ok(Json(app.store.save(&b).map_err(bad)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app() -> App {
        let dir = std::env::temp_dir().join(format!("spoofer-test-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        AppState::new(Store::new(Some(dir.join("data.json"))), Updater::new(false))
    }

    fn route() -> RouteIn {
        serde_json::from_value(json!({
            "name": "Test",
            "waypoints": [{"lat": 51.5, "lon": -0.12}, {"lat": 51.501, "lon": -0.12, "dwell_s": 5}, {"lat": 51.502, "lon": -0.119, "speed_kmh": 10}],
            "legs": [{"mode": "straight", "cruise_kmh": 20}, {"mode": "straight", "ramp": "linear"}],
            "settings": {"default_cruise_kmh": 5, "accel_ms2": 1, "decel_ms2": 1},
            "alternatives": 2,
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn build_reports_progress_in_order() {
        let seen: Arc<Mutex<Vec<(f64, String, f64)>>> = Arc::new(Mutex::new(Vec::new()));
        let s2 = seen.clone();
        let progress: Progress = Arc::new(move |p, m, n| s2.lock().unwrap().push((p, m.to_string(), n)));
        let v = build_route_core(app(), route(), progress).await.unwrap_or_else(|e| panic!("{}", e.1));
        let seen = seen.lock().unwrap();
        let msgs: Vec<&str> = seen.iter().map(|x| x.1.as_str()).collect();
        assert_eq!(msgs[0], "Checking 3 checkpoints");
        assert!(msgs.contains(&"Drawing a straight line · leg 2 of 2"));
        assert!(msgs.contains(&"Calculating the ETA"));
        assert!(seen.windows(2).all(|w| w[1].0 >= w[0].0) && seen.iter().all(|x| x.2 >= x.0));
        // straight legs have no alternatives, even when they are asked for
        assert_eq!(v["alternatives"], json!([]));
        assert_eq!(v["alternatives_requested"], json!(2));
        assert_eq!(v["option"]["label"], "A");
        let rows = v["preview"].as_array().unwrap();
        assert!(rows.iter().all(|r| r.as_array().unwrap().len() == 5));
        let last = rows.last().unwrap()[4].as_f64().unwrap();
        assert!((last - v["summary"]["distance_m"].as_f64().unwrap()).abs() < 0.2);
    }

    #[tokio::test]
    async fn hold_checkpoints_and_the_simulator_version() {
        let mut r = route();
        r.waypoints[1].hold = true;
        r.waypoints[1].dwell_s = 0.0;
        let quiet: Progress = Arc::new(|_, _, _| {});
        let v = build_route_core(app(), r, quiet).await.unwrap_or_else(|e| panic!("{}", e.1));
        assert_eq!(v["summary"]["holds"], 1);
        assert_eq!(crate::device::mock::SIMULATED_IOS, "27");
        let held: WaypointIn = serde_json::from_value(json!({"lat": 1.0, "lon": 2.0, "hold": true})).unwrap();
        assert!(held.hold && !serde_json::from_value::<WaypointIn>(json!({"lat": 1.0, "lon": 2.0})).unwrap().hold);
    }

    #[tokio::test]
    async fn bad_requests_are_rejected_before_routing() {
        let mut r = route();
        r.alternatives = 9;
        assert_eq!(check_route_in(&r).unwrap_err().0, 422);
        let mut r = route();
        r.legs.truncate(1);
        let quiet: Progress = Arc::new(|_, _, _| {});
        let e = build_route_core(app(), r, quiet).await.unwrap_err();
        assert_eq!((e.0, e.1.as_str()), (400, "Expected 2 legs, got 1"));
    }
}
