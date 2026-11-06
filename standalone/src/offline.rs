//! Offline maps: a local cache in front of OpenFreeMap, and downloads of map areas into it.
//!
//! The page loads OpenFreeMap through `/ofm/<path>` (MapLibre's transformRequest), so the map can
//! come from the cache when there is no internet. Only areas the user downloads are stored tile by
//! tile; styles, sprites and fonts are kept whenever they are fetched (a small, fixed set).
//!
//! OpenFreeMap's terms allow offline downloads of at most 3,000 tiles or 50 MB each, with at most
//! 4 parallel requests and a User-Agent that names the app. The same limits are in the browser
//! edition (offline.py).

use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub const UPSTREAM: &str = "https://tiles.openfreemap.org/";
pub const MAX_TILES: usize = 3000;
pub const MAX_BYTES: u64 = 50 * 1024 * 1024;
pub const PARALLEL: usize = 4;
/// OpenFreeMap's vector tiles stop at zoom 14; closer zooms are drawn from them.
pub const VECTOR_MAX_ZOOM: u8 = 14;
/// The shaded-relief raster in the styles only exists up to zoom 6.
pub const RELIEF_MAX_ZOOM: u8 = 6;
pub const STYLES: [&str; 2] = ["styles/dark", "styles/liberty"];
/// Font ranges kept offline: Latin, Latin extended, Greek, Cyrillic, punctuation and symbols.
pub const GLYPH_RANGES: [&str; 7] = ["0-255", "256-511", "512-767", "768-1023", "1024-1279", "8192-8447", "8448-8703"];
const RELIEF_PREFIX: &str = "natural_earth/ne2sr/";
const TILE_PREFIX: &str = "planet-tiles/";
/// 1x1 transparent PNG: answer for a relief tile that is neither cached nor reachable.
const EMPTY_PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00,
    0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D,
    0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
];

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
pub struct Bounds {
    pub south: f64,
    pub west: f64,
    pub north: f64,
    pub east: f64,
}

impl Bounds {
    pub fn validated(self) -> Result<Bounds, String> {
        let b = Bounds {
            south: self.south.clamp(-85.0511, 85.0511),
            north: self.north.clamp(-85.0511, 85.0511),
            west: self.west.clamp(-180.0, 180.0),
            east: self.east.clamp(-180.0, 180.0),
        };
        if ![b.south, b.west, b.north, b.east].iter().all(|v| v.is_finite()) || b.south >= b.north || b.west >= b.east {
            return Err("Choose an area on the map first.".into());
        }
        Ok(b)
    }
}

/// Tile column and row of a point at zoom z (Web Mercator, as the map uses).
pub fn tile_xy(lat: f64, lon: f64, z: u8) -> (u32, u32) {
    let n = f64::from(1u32 << z);
    let lat = lat.clamp(-85.0511, 85.0511).to_radians();
    let x = ((lon + 180.0) / 360.0 * n).floor();
    let y = ((1.0 - (lat.tan() + 1.0 / lat.cos()).ln() / std::f64::consts::PI) / 2.0 * n).floor();
    let max = n - 1.0;
    (x.clamp(0.0, max) as u32, y.clamp(0.0, max) as u32)
}

/// Every (z, x, y) covering the bounds from min_z to max_z.
pub fn tiles(b: &Bounds, min_z: u8, max_z: u8) -> Vec<(u8, u32, u32)> {
    let mut out = Vec::new();
    for z in min_z..=max_z {
        let (x0, y0) = tile_xy(b.north, b.west, z);
        let (x1, y1) = tile_xy(b.south, b.east, z);
        for x in x0..=x1 {
            for y in y0..=y1 {
                out.push((z, x, y));
            }
        }
    }
    out
}

pub fn tile_count(b: &Bounds, min_z: u8, max_z: u8) -> usize {
    (min_z..=max_z)
        .map(|z| {
            let (x0, y0) = tile_xy(b.north, b.west, z);
            let (x1, y1) = tile_xy(b.south, b.east, z);
            (x1 - x0 + 1) as usize * (y1 - y0 + 1) as usize
        })
        .sum()
}

pub type Tiles = Vec<(u8, u32, u32)>;

/// Vector tiles plus shaded-relief tiles needed for an area.
pub fn area_tiles(b: &Bounds, min_z: u8, max_z: u8) -> (Tiles, Tiles) {
    let max_z = max_z.min(VECTOR_MAX_ZOOM);
    let relief = if min_z <= RELIEF_MAX_ZOOM { tiles(b, min_z, max_z.min(RELIEF_MAX_ZOOM)) } else { Vec::new() };
    (tiles(b, min_z, max_z), relief)
}

pub fn area_tile_count(b: &Bounds, min_z: u8, max_z: u8) -> usize {
    let max_z = max_z.min(VECTOR_MAX_ZOOM);
    tile_count(b, min_z, max_z) + if min_z <= RELIEF_MAX_ZOOM { tile_count(b, min_z, max_z.min(RELIEF_MAX_ZOOM)) } else { 0 }
}

#[derive(Debug, PartialEq)]
pub enum Kind {
    /// Map tiles: served from the cache when an area holds them, else fetched without storing.
    Tile,
    /// Sprites and fonts: never change for a given path, so cache-first and always stored.
    Static,
    /// Styles and the tile index: network first (they change), the cache when offline.
    Fresh,
}

/// Where a request path is kept in the cache, and how it is treated. None for paths that are
/// not part of the map (or try to leave the cache folder).
pub fn cache_key(path: &str) -> Option<(String, Kind)> {
    if path.is_empty() || path.len() > 300 || path.starts_with('/') || path.split('/').any(|s| s.is_empty() || s == "." || s == "..") {
        return None;
    }
    if !path.chars().all(|c| c.is_ascii_alphanumeric() || "._-/%@,".contains(c)) {
        return None;
    }
    let parts: Vec<&str> = path.split('/').collect();
    match parts.as_slice() {
        // planet/<version>/z/x/y.pbf: kept without the weekly version, so areas survive updates
        ["planet", _ver, z, x, y] if y.ends_with(".pbf") => Some((format!("{TILE_PREFIX}{z}/{x}/{y}"), Kind::Tile)),
        ["planet"] => Some(("planet.json".into(), Kind::Fresh)),
        ["styles", _] => Some((format!("{path}.json"), Kind::Fresh)),
        ["natural_earth", ..] => Some((path.into(), Kind::Tile)),
        ["sprites", ..] | ["fonts", ..] => Some((path.into(), Kind::Static)),
        _ => None,
    }
}

fn content_type(key: &str) -> &'static str {
    if key.ends_with(".pbf") {
        "application/x-protobuf"
    } else if key.ends_with(".png") {
        "image/png"
    } else {
        "application/json"
    }
}

#[derive(Default, Clone)]
struct Job {
    running: bool,
    name: String,
    done: usize,
    total: usize,
    bytes: u64,
    error: Option<String>,
    finished: Option<String>,
}

pub struct Offline {
    dir: PathBuf,
    /// OpenFreeMap (tests point this at a local server).
    upstream: String,
    http: reqwest::Client,
    job: Mutex<Job>,
    cancel: AtomicBool,
    areas_lock: Mutex<()>,
}

pub struct Answer {
    pub status: u16,
    pub content_type: &'static str,
    pub body: Vec<u8>,
}

#[derive(Deserialize)]
pub struct DownloadIn {
    pub name: Option<String>,
    pub bounds: Bounds,
    pub min_zoom: Option<u8>,
    pub max_zoom: u8,
}

impl Offline {
    pub fn new(data_dir: &Path) -> Arc<Self> {
        let http = reqwest::Client::builder()
            .user_agent(format!("LocationSpoofer/{} (+https://github.com/YK3D/iPhone-location-spoofer)", crate::updater::current_version()))
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .expect("http client");
        Arc::new(Self { dir: data_dir.join("offline"), upstream: UPSTREAM.into(), http, job: Mutex::new(Job::default()), cancel: AtomicBool::new(false), areas_lock: Mutex::new(()) })
    }

    fn file(&self, key: &str) -> PathBuf {
        self.dir.join("cache").join(key)
    }

    fn read(&self, key: &str) -> Option<Vec<u8>> {
        std::fs::read(self.file(key)).ok()
    }

    fn write(&self, key: &str, data: &[u8]) {
        let f = self.file(key);
        if let Some(d) = f.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let tmp = f.with_extension("part");
        if std::fs::write(&tmp, data).is_ok() {
            let _ = std::fs::rename(&tmp, &f);
        }
    }

    async fn fetch(&self, path: &str) -> Result<Vec<u8>, String> {
        let r = self.http.get(format!("{}{path}", self.upstream)).send().await.map_err(|e| e.to_string())?;
        if !r.status().is_success() {
            return Err(format!("OpenFreeMap answered {}", r.status().as_u16()));
        }
        Ok(r.bytes().await.map_err(|e| e.to_string())?.to_vec())
    }

    /// Answer a map request from the page (`/ofm/<path>`).
    pub async fn proxy(&self, path: &str) -> Answer {
        let Some((key, kind)) = cache_key(path) else {
            return Answer { status: 404, content_type: "text/plain", body: b"not a map file".to_vec() };
        };
        let ct = content_type(&key);
        let ok = |body: Vec<u8>| Answer { status: 200, content_type: ct, body };
        match kind {
            Kind::Tile => {
                if let Some(b) = self.read(&key) {
                    return ok(b);
                }
                match self.fetch(path).await {
                    Ok(b) => ok(b),
                    // Offline and not downloaded: an empty tile, so the map shows what it has
                    // instead of counting errors and giving up.
                    Err(_) if ct == "image/png" => ok(EMPTY_PNG.to_vec()),
                    Err(_) => ok(Vec::new()),
                }
            }
            Kind::Static => {
                if let Some(b) = self.read(&key) {
                    return ok(b);
                }
                match self.fetch(path).await {
                    Ok(b) => {
                        self.write(&key, &b);
                        ok(b)
                    }
                    Err(e) => Answer { status: 502, content_type: "text/plain", body: e.into_bytes() },
                }
            }
            Kind::Fresh => match self.fetch(path).await {
                Ok(b) => {
                    self.write(&key, &b);
                    ok(b)
                }
                Err(e) => match self.read(&key) {
                    Some(b) => ok(b),
                    None => Answer { status: 502, content_type: "text/plain", body: e.into_bytes() },
                },
            },
        }
    }

    // ------------------------------------------------------------ areas
    fn areas_file(&self) -> PathBuf {
        self.dir.join("areas.json")
    }

    pub fn areas(&self) -> Vec<Value> {
        std::fs::read_to_string(self.areas_file())
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
    }

    fn save_areas(&self, areas: &[Value]) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let tmp = self.areas_file().with_extension("tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(areas).unwrap()).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, self.areas_file()).map_err(|e| e.to_string())
    }

    fn area_bounds(a: &Value) -> Option<(Bounds, u8, u8)> {
        let f = |k: &str| a[k].as_f64();
        let b = Bounds { south: f("south")?, west: f("west")?, north: f("north")?, east: f("east")? };
        Some((b, a["min_zoom"].as_u64()? as u8, a["max_zoom"].as_u64()? as u8))
    }

    /// Delete stored tiles that no saved area needs any more.
    pub fn collect_garbage(&self) {
        let _g = self.areas_lock.lock().unwrap();
        let mut keep: HashSet<String> = HashSet::new();
        for a in self.areas() {
            if let Some((b, lo, hi)) = Self::area_bounds(&a) {
                let (vec, relief) = area_tiles(&b, lo, hi);
                keep.extend(vec.iter().map(|(z, x, y)| format!("{TILE_PREFIX}{z}/{x}/{y}.pbf")));
                keep.extend(relief.iter().map(|(z, x, y)| format!("{RELIEF_PREFIX}{z}/{x}/{y}.png")));
            }
        }
        let root = self.dir.join("cache");
        for prefix in [TILE_PREFIX, RELIEF_PREFIX] {
            let base = root.join(prefix);
            let mut stack = vec![base.clone()];
            while let Some(d) = stack.pop() {
                let Ok(rd) = std::fs::read_dir(&d) else { continue };
                for e in rd.flatten() {
                    let p = e.path();
                    if p.is_dir() {
                        stack.push(p);
                    } else if let Ok(rel) = p.strip_prefix(&root) {
                        let key = rel.to_string_lossy().replace('\\', "/");
                        if !keep.contains(&key) {
                            let _ = std::fs::remove_file(&p);
                        }
                    }
                }
            }
        }
    }

    pub fn delete_area(&self, id: &str) -> Result<(), String> {
        {
            let _g = self.areas_lock.lock().unwrap();
            let mut areas = self.areas();
            let before = areas.len();
            areas.retain(|a| a["id"] != id);
            if areas.len() == before {
                return Err("That offline area no longer exists.".into());
            }
            self.save_areas(&areas)?;
        }
        self.collect_garbage();
        Ok(())
    }

    pub fn status(&self) -> Value {
        let j = self.job.lock().unwrap().clone();
        json!({
            "areas": self.areas(),
            "job": {"running": j.running, "name": j.name, "done": j.done, "total": j.total, "bytes": j.bytes,
                    "error": j.error, "finished": j.finished},
            "limits": {"max_tiles": MAX_TILES, "max_bytes": MAX_BYTES, "max_zoom": VECTOR_MAX_ZOOM},
        })
    }

    pub fn estimate(b: Bounds, min_z: u8, max_z: u8) -> Result<Value, String> {
        let b = b.validated()?;
        let tiles = area_tile_count(&b, min_z, max_z.min(VECTOR_MAX_ZOOM));
        Ok(json!({"tiles": tiles, "max_tiles": MAX_TILES, "ok": tiles <= MAX_TILES}))
    }

    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    /// Check the request and start downloading in the background.
    pub fn start(self: &Arc<Self>, req: DownloadIn) -> Result<Value, String> {
        let b = req.bounds.validated()?;
        let max_z = req.max_zoom.min(VECTOR_MAX_ZOOM);
        let min_z = req.min_zoom.unwrap_or(0).min(max_z);
        let total = area_tile_count(&b, min_z, max_z);
        if total > MAX_TILES {
            return Err(format!(
                "This area needs {total} map tiles; OpenFreeMap allows {MAX_TILES} per download. Zoom in on a smaller area or lower the detail."
            ));
        }
        let name = req.name.unwrap_or_default().trim().chars().take(60).collect::<String>();
        let name = if name.is_empty() { format!("Area {:.3}, {:.3}", (b.south + b.north) / 2.0, (b.west + b.east) / 2.0) } else { name };
        {
            let mut j = self.job.lock().unwrap();
            if j.running {
                return Err("A download is already running.".into());
            }
            *j = Job { running: true, name: name.clone(), total, ..Default::default() };
        }
        self.cancel.store(false, Ordering::SeqCst);
        let me = self.clone();
        tokio::spawn(async move {
            let result = me.download(&name, b, min_z, max_z).await;
            let failed = result.is_err();
            {
                let mut j = me.job.lock().unwrap();
                j.running = false;
                match result {
                    Ok(()) => j.finished = Some(name),
                    Err(e) => j.error = Some(e),
                }
            }
            // the tiles of a failed or cancelled download belong to no area
            if failed {
                let m = me.clone();
                let _ = tokio::task::spawn_blocking(move || m.collect_garbage()).await;
            }
        });
        Ok(self.status())
    }

    fn add_bytes(&self, n: u64) -> Result<(), String> {
        let mut j = self.job.lock().unwrap();
        j.bytes += n;
        if j.bytes > MAX_BYTES {
            return Err("The download passed OpenFreeMap's 50 MB limit and was stopped. Choose a smaller area or less detail.".into());
        }
        Ok(())
    }

    async fn keep(&self, path: &str, key: &str) -> Result<(), String> {
        if self.cancel.load(Ordering::SeqCst) {
            return Err("Download cancelled.".into());
        }
        let b = self.fetch(path).await?;
        self.add_bytes(b.len() as u64)?;
        self.write(key, &b);
        Ok(())
    }

    async fn download(&self, name: &str, b: Bounds, min_z: u8, max_z: u8) -> Result<(), String> {
        // the tile index (it names this week's tile folder), both styles, their sprites and fonts
        let index = self.fetch("planet").await.map_err(|e| format!("Couldn't reach OpenFreeMap: {e}"))?;
        self.write("planet.json", &index);
        let index: Value = serde_json::from_slice(&index).map_err(|_| "OpenFreeMap sent an unexpected tile index.")?;
        let template = index["tiles"][0].as_str().unwrap_or("").to_string();
        let tile_path = template.strip_prefix(self.upstream.as_str()).filter(|t| t.contains("{z}")).ok_or("OpenFreeMap sent an unexpected tile index.")?.to_string();
        let mut extra: Vec<String> = Vec::new();
        for style in STYLES {
            let body = self.fetch(style).await?;
            self.write(&format!("{style}.json"), &body);
            let s: Value = serde_json::from_slice(&body).map_err(|_| "OpenFreeMap sent an unexpected map style.")?;
            if let Some(sprite) = s["sprite"].as_str().and_then(|u| u.strip_prefix(self.upstream.as_str())) {
                for suffix in [".json", ".png", "@2x.json", "@2x.png"] {
                    extra.push(format!("{sprite}{suffix}"));
                }
            }
            if let Some(glyphs) = s["glyphs"].as_str().and_then(|u| u.strip_prefix(self.upstream.as_str())) {
                let mut stacks: HashSet<String> = HashSet::new();
                for l in s["layers"].as_array().into_iter().flatten() {
                    if let Some(f) = l["layout"]["text-font"].as_array() {
                        let names: Vec<&str> = f.iter().filter_map(|v| v.as_str()).collect();
                        if !names.is_empty() {
                            stacks.insert(names.join(","));
                        }
                    }
                }
                for stack in stacks {
                    let enc = stack.replace(' ', "%20"); // as the page's fetch() sends it
                    for range in GLYPH_RANGES {
                        extra.push(glyphs.replace("{fontstack}", &enc).replace("{range}", range));
                    }
                }
            }
        }
        extra.sort();
        extra.dedup();
        for p in &extra {
            if let Some((key, _)) = cache_key(p) {
                if self.read(&key).is_none() {
                    self.keep(p, &key).await?;
                }
            }
        }
        // the tiles, at most 4 at a time
        let (vector, relief) = area_tiles(&b, min_z, max_z);
        let mut jobs: Vec<(String, String)> = Vec::new();
        for (z, x, y) in vector {
            let p = tile_path.replace("{z}", &z.to_string()).replace("{x}", &x.to_string()).replace("{y}", &y.to_string());
            jobs.push((p, format!("{TILE_PREFIX}{z}/{x}/{y}.pbf")));
        }
        for (z, x, y) in relief {
            let k = format!("{RELIEF_PREFIX}{z}/{x}/{y}.png");
            jobs.push((k.clone(), k));
        }
        let mut results = futures_util::stream::iter(jobs.into_iter().map(|(p, k)| async move {
            let r = if self.read(&k).is_some() { Ok(()) } else { self.keep(&p, &k).await };
            self.job.lock().unwrap().done += 1;
            r
        }))
        .buffer_unordered(PARALLEL);
        while let Some(r) = results.next().await {
            if let Err(e) = r {
                self.cancel.store(true, Ordering::SeqCst); // stop the other requests too
                return Err(e);
            }
        }
        // the area's size on disk (tiles it shares with other areas are counted for each)
        let (vector, relief) = area_tiles(&b, min_z, max_z);
        let size: u64 = vector
            .iter()
            .map(|(z, x, y)| format!("{TILE_PREFIX}{z}/{x}/{y}.pbf"))
            .chain(relief.iter().map(|(z, x, y)| format!("{RELIEF_PREFIX}{z}/{x}/{y}.png")))
            .filter_map(|k| std::fs::metadata(self.file(&k)).ok().map(|m| m.len()))
            .sum();
        let area = json!({
            "id": format!("{:x}", rand::random::<u64>()),
            "name": name, "south": b.south, "west": b.west, "north": b.north, "east": b.east,
            "min_zoom": min_z, "max_zoom": max_z, "tiles": self.job.lock().unwrap().total,
            "bytes": size, "created": chrono::Utc::now().to_rfc3339(),
        });
        let _g = self.areas_lock.lock().unwrap();
        let mut areas = self.areas();
        areas.push(area);
        self.save_areas(&areas)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tile_math() {
        assert_eq!(tile_xy(0.0, 0.0, 1), (1, 1));
        assert_eq!(tile_xy(51.5074, -0.1278, 14), (8186, 5448));
        assert_eq!(tile_xy(85.0511, -180.0, 3), (0, 0));
        assert_eq!(tile_xy(-85.0511, 180.0, 3), (7, 7));
        let b = Bounds { south: 51.49, west: -0.15, north: 51.52, east: -0.1 };
        assert_eq!(tile_count(&b, 0, 14), tiles(&b, 0, 14).len());
        // relief tiles only up to zoom 6, vector tiles up to 14 even when more is asked
        assert_eq!(area_tile_count(&b, 0, 18), tile_count(&b, 0, 14) + tile_count(&b, 0, 6));
        assert_eq!(area_tile_count(&b, 10, 14), tile_count(&b, 10, 14));
    }

    #[test]
    fn bounds_and_limits() {
        assert!(Bounds { south: 1.0, west: 1.0, north: 0.5, east: 2.0 }.validated().is_err());
        let world = Bounds { south: -80.0, west: -179.0, north: 80.0, east: 179.0 };
        assert_eq!(Offline::estimate(world, 0, 14).unwrap()["ok"], false);
        let city = Bounds { south: 51.49, west: -0.15, north: 51.52, east: -0.1 };
        assert_eq!(Offline::estimate(city, 0, 14).unwrap()["ok"], true);
    }

    #[test]
    fn cache_keys() {
        assert_eq!(cache_key("planet/20261101_080013_pt/14/8186/5448.pbf"), Some(("planet-tiles/14/8186/5448.pbf".into(), Kind::Tile)));
        assert_eq!(cache_key("planet"), Some(("planet.json".into(), Kind::Fresh)));
        assert_eq!(cache_key("styles/dark"), Some(("styles/dark.json".into(), Kind::Fresh)));
        assert_eq!(cache_key("fonts/Noto%20Sans%20Regular/0-255.pbf").unwrap().1, Kind::Static);
        assert_eq!(cache_key("sprites/ofm_f384/ofm@2x.png").unwrap().1, Kind::Static);
        assert_eq!(cache_key("natural_earth/ne2sr/3/4/2.png").unwrap().1, Kind::Tile);
        for bad in ["../x", "fonts/../../etc", "/etc/passwd", "styles/a b", "other/x", "fonts//x", "planet/v/1/2"] {
            assert!(cache_key(bad).is_none(), "{bad}");
        }
    }

    #[tokio::test]
    async fn cached_files_and_cleanup() {
        let dir = std::env::temp_dir().join(format!("spoofer-offline-{}", rand::random::<u32>()));
        let off = Offline::new(&dir);
        // a cached tile is served without the network
        off.write("planet-tiles/14/8186/5448.pbf", b"tile");
        let a = off.proxy("planet/anyversion/14/8186/5448.pbf").await;
        assert_eq!((a.status, a.body.as_slice(), a.content_type), (200, &b"tile"[..], "application/x-protobuf"));
        assert_eq!(off.proxy("../secret").await.status, 404);
        // tiles of a saved area stay, others go
        let b = Bounds { south: 51.50, west: -0.13, north: 51.51, east: -0.12 };
        off.save_areas(&[json!({"id": "a1", "name": "x", "south": b.south, "west": b.west, "north": b.north, "east": b.east, "min_zoom": 14, "max_zoom": 14})]).unwrap();
        off.write("planet-tiles/3/1/1.pbf", b"orphan");
        off.collect_garbage();
        assert!(off.read("planet-tiles/14/8186/5448.pbf").is_some());
        assert!(off.read("planet-tiles/3/1/1.pbf").is_none());
        off.delete_area("a1").unwrap();
        assert!(off.read("planet-tiles/14/8186/5448.pbf").is_none());
        assert!(off.delete_area("a1").is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A stand-in for OpenFreeMap on a local port.
    async fn fake_ofm() -> String {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        let b2 = base.clone();
        let app = axum::Router::new().fallback(move |uri: axum::http::Uri| {
            let base = b2.clone();
            async move {
                let p = uri.path().trim_start_matches('/').to_string();
                if p == "planet" {
                    axum::Json(json!({"tiles": [format!("{base}planet/v1/{{z}}/{{x}}/{{y}}.pbf")]})).into_response()
                } else if p.starts_with("styles/") {
                    axum::Json(json!({"sprite": format!("{base}sprites/ofm_f384/ofm"), "glyphs": format!("{base}fonts/{{fontstack}}/{{range}}.pbf"),
                        "layers": [{"id": "a", "layout": {"text-font": ["Noto Sans Regular"]}}]})).into_response()
                } else {
                    format!("data:{p}").into_response()
                }
            }
        });
        tokio::spawn(async move { axum::serve(listener, app).await.ok() });
        base
    }
    use axum::response::IntoResponse;

    #[tokio::test]
    async fn download_then_offline() {
        let dir = std::env::temp_dir().join(format!("spoofer-offline-dl-{}", rand::random::<u32>()));
        let mut off = Offline::new(&dir);
        Arc::get_mut(&mut off).unwrap().upstream = fake_ofm().await;
        let city = Bounds { south: 51.50, west: -0.13, north: 51.51, east: -0.12 };
        off.start(DownloadIn { name: Some("Home".into()), bounds: city, min_zoom: Some(12), max_zoom: 14 }).unwrap();
        for _ in 0..500 {
            // finished, and the download task has let go of its handle
            if !off.job.lock().unwrap().running && Arc::strong_count(&off) == 1 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let st = off.status();
        assert!(st["job"]["error"].is_null(), "{st}");
        assert_eq!(st["job"]["done"], area_tile_count(&city, 12, 14));
        assert_eq!(st["areas"][0]["name"], "Home");
        assert!(off.read("fonts/Noto%20Sans%20Regular/0-255.pbf").is_some());
        assert!(off.read("sprites/ofm_f384/ofm@2x.png").is_some());
        // without internet the cached tiles, styles and fonts still answer
        Arc::get_mut(&mut off).unwrap().upstream = "http://127.0.0.1:9/".into();
        let (z, x, y) = tiles(&city, 14, 14)[0];
        let a = off.proxy(&format!("planet/v2/{z}/{x}/{y}.pbf")).await;
        assert_eq!(a.body, format!("data:planet/v1/{z}/{x}/{y}.pbf").into_bytes());
        assert_eq!(off.proxy("styles/dark").await.status, 200);
        assert_eq!(off.proxy("planet/v1/3/1/1.pbf").await.body, Vec::<u8>::new());
        assert_eq!(off.proxy("natural_earth/ne2sr/0/0/0.png").await.body, EMPTY_PNG);
        assert!(off.start(DownloadIn { name: None, bounds: Bounds { south: -80.0, west: -179.0, north: 80.0, east: 179.0 }, min_zoom: None, max_zoom: 14 }).unwrap_err().contains("3000"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
