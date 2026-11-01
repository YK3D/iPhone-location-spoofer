//! Tiny JSON store for favourites, saved routes and settings.

use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;

pub fn data_dir() -> PathBuf {
    if let Ok(d) = std::env::var("SPOOFER_DATA_DIR") {
        return PathBuf::from(d);
    }
    dirs::data_dir()
        .map(|d| d.join("LocationSpooferStandalone"))
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".location-spoofer-standalone"))
}

pub struct Store {
    path: PathBuf,
    lock: Mutex<()>,
}

impl Store {
    pub fn new(path: Option<PathBuf>) -> Self {
        Self { path: path.unwrap_or_else(|| data_dir().join("data.json")), lock: Mutex::new(()) }
    }

    pub fn load(&self) -> Value {
        let _g = self.lock.lock().unwrap();
        let mut v: Value = std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .filter(|v: &Value| v.is_object())
            .unwrap_or_else(|| json!({}));
        for (k, d) in [("favorites", json!([])), ("routes", json!([])), ("settings", json!({}))] {
            if v.get(k).is_none() {
                v[k] = d;
            }
        }
        v
    }

    pub fn save(&self, data: &Value) -> Result<Value, String> {
        let fav = data.get("favorites").cloned().unwrap_or(json!([]));
        let routes = data.get("routes").cloned().unwrap_or(json!([]));
        let settings = data.get("settings").cloned().unwrap_or(json!({}));
        if !fav.is_array() {
            return Err("favorites must be a list".into());
        }
        if !routes.is_array() {
            return Err("routes must be a list".into());
        }
        if !settings.is_object() {
            return Err("settings must be an object".into());
        }
        let clean = json!({"favorites": fav, "routes": routes, "settings": settings});
        let _g = self.lock.lock().unwrap();
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = self.path.with_extension("tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(&clean).unwrap()).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.path).map_err(|e| e.to_string())?;
        Ok(clean)
    }

    pub fn google_key(&self) -> Option<String> {
        self.load()["settings"]["google_api_key"].as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from)
    }
}
