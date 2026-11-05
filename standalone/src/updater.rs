//! Self-update for the standalone exe from GitHub Releases tagged `standalone-v<version>`.
//!
//! Same scheme as the browser version: download next to the exe, verify SHA-256 and the
//! download host, then swap on "Restart now" or at the next launch (Windows allows renaming a
//! running exe). Disabled in Microsoft Store builds (`--features store`): the Store updates
//! packaged apps itself and its policies do not allow self-updating packages.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Mutex;

pub const REPO: &str = "YK3D/iPhone-location-spoofer";
pub const TAG_PREFIX: &str = "standalone-v";
pub const ASSET: &str = "LocationSpooferStandalone.exe";
const ALLOWED_HOSTS: [&str; 3] = ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"];

pub fn current_version() -> &'static str {
    option_env!("SPOOFER_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"))
}

pub fn parse_version(s: &str) -> Vec<u64> {
    let s = s.trim().trim_start_matches(TAG_PREFIX).trim_start_matches('v');
    let num: String = s.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    num.split('.').filter(|x| !x.is_empty()).filter_map(|x| x.parse().ok()).collect()
}

pub fn is_newer(candidate: &str, current: &str) -> bool {
    let (mut a, mut b) = (parse_version(candidate), parse_version(current));
    if a.is_empty() {
        return false;
    }
    let n = a.len().max(b.len());
    a.resize(n, 0);
    b.resize(n, 0);
    a > b
}

#[derive(Default)]
struct UState {
    state: String,
    latest: Option<String>,
    notes: String,
    error: Option<String>,
    progress: f64,
}

pub struct Updater {
    pub enabled: bool,
    exe: PathBuf,
    st: Mutex<UState>,
    busy: tokio::sync::Mutex<()>,
}

impl Updater {
    pub fn new(enabled: bool) -> Self {
        let exe = std::env::current_exe().unwrap_or_default();
        Self {
            enabled,
            exe,
            st: Mutex::new(UState { state: if enabled { "idle".into() } else { "disabled".into() }, ..Default::default() }),
            busy: tokio::sync::Mutex::new(()),
        }
    }

    fn sibling(&self, suffix: &str) -> PathBuf {
        let stem = self.exe.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "LocationSpooferStandalone".into());
        self.exe.with_file_name(format!("{stem}{suffix}"))
    }
    fn staged(&self) -> PathBuf {
        self.sibling(".update.exe")
    }
    fn staged_meta(&self) -> PathBuf {
        self.sibling(".update.json")
    }
    fn old(&self) -> PathBuf {
        self.sibling(".old.exe")
    }

    pub fn status(&self) -> Value {
        let s = self.st.lock().unwrap();
        json!({"enabled": self.enabled, "state": s.state, "current": current_version(), "latest": s.latest,
               "notes": s.notes, "error": s.error, "progress": s.progress, "repo": REPO})
    }

    pub fn staged_version(&self) -> Option<String> {
        let meta: Value = serde_json::from_str(&std::fs::read_to_string(self.staged_meta()).ok()?).ok()?;
        let bytes = std::fs::read(self.staged()).ok()?;
        let digest = hex::encode(Sha256::digest(&bytes));
        let v = meta["version"].as_str()?.to_string();
        (digest == meta["sha256"].as_str()? && is_newer(&v, current_version())).then_some(v)
    }

    pub fn cleanup_old(&self) {
        for _ in 0..40 {
            if !self.old().exists() || std::fs::remove_file(self.old()).is_ok() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    }

    pub fn swap_in_staged(&self) -> Result<bool, String> {
        if self.staged_version().is_none() {
            return Ok(false);
        }
        let _ = std::fs::remove_file(self.old());
        std::fs::rename(&self.exe, self.old()).map_err(|e| {
            format!("Could not replace the program file ({e}). Move the app to a folder you can write to, e.g. your Desktop.")
        })?;
        if let Err(e) = std::fs::rename(self.staged(), &self.exe) {
            let _ = std::fs::rename(self.old(), &self.exe);
            return Err(format!("Could not install the update: {e}"));
        }
        let _ = std::fs::remove_file(self.staged_meta());
        refresh_shell_icons(&self.exe);
        Ok(true)
    }

    pub fn relaunch(&self, mut args: Vec<String>) {
        if let Some(i) = args.iter().position(|a| a == "--wait-pid") {
            args.drain(i..(i + 2).min(args.len()));
        }
        args.push("--wait-pid".into());
        args.push(std::process::id().to_string());
        let _ = std::process::Command::new(&self.exe).args(args).spawn();
    }

    fn set(&self, f: impl FnOnce(&mut UState)) {
        f(&mut self.st.lock().unwrap());
    }

    pub async fn check(&self, channel: &str) -> Value {
        if !self.enabled {
            return self.status();
        }
        let Ok(_guard) = self.busy.try_lock() else { return self.status() };
        self.set(|s| {
            s.state = "checking".into();
            s.error = None;
        });
        if let Err(e) = self.check_inner(channel).await {
            self.set(|s| {
                s.state = "error".into();
                s.error = Some(e);
            });
        }
        self.status()
    }

    async fn check_inner(&self, channel: &str) -> Result<(), String> {
        let http = crate::routing::http();
        let rels: Vec<Value> = http
            .get(format!("https://api.github.com/repos/{REPO}/releases?per_page=40"))
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        let rel = pick_release(&rels, channel);
        let Some(rel) = rel else {
            self.set(|s| s.state = "up_to_date".into());
            return Ok(());
        };
        let tag = rel["tag_name"].as_str().unwrap_or("").to_string();
        let latest = tag.trim_start_matches(TAG_PREFIX).to_string();
        self.set(|s| {
            s.latest = Some(latest.clone());
            s.notes = rel["body"].as_str().unwrap_or("").chars().take(2000).collect();
        });
        if !is_newer(&latest, current_version()) {
            self.set(|s| s.state = "up_to_date".into());
            return Ok(());
        }
        if self.staged_version().as_deref() == Some(latest.as_str()) {
            self.set(|s| s.state = "ready".into());
            return Ok(());
        }
        let asset = |name: &str| {
            rel["assets"].as_array().into_iter().flatten().find(|a| a["name"] == name).and_then(|a| a["browser_download_url"].as_str().map(String::from))
        };
        let (exe_url, sum_url) = (asset(ASSET).ok_or("Release has no exe")?, asset(&format!("{ASSET}.sha256")).ok_or("Release has no checksum")?);
        for u in [&exe_url, &sum_url] {
            check_host(u)?;
        }
        let sum = http.get(&sum_url).send().await.map_err(|e| e.to_string())?.text().await.map_err(|e| e.to_string())?;
        let expected = sum.split_whitespace().next().unwrap_or("").to_lowercase();
        if expected.len() != 64 || !expected.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("The release checksum file is malformed".into());
        }
        self.set(|s| s.state = "downloading".into());
        let resp = http.get(&exe_url).send().await.map_err(|e| e.to_string())?;
        check_host(resp.url().as_str())?;
        let total = resp.content_length().unwrap_or(0) as f64;
        let mut hasher = Sha256::new();
        let mut buf: Vec<u8> = Vec::new();
        let mut stream = resp.bytes_stream();
        use futures_util::StreamExt;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| e.to_string())?;
            hasher.update(&chunk);
            buf.extend_from_slice(&chunk);
            if total > 0.0 {
                let p = buf.len() as f64 / total;
                self.set(|s| s.progress = p);
            }
        }
        if hex::encode(hasher.finalize()) != expected {
            return Err("Downloaded update failed the SHA-256 check and was discarded".into());
        }
        std::fs::write(self.staged(), &buf).map_err(|e| e.to_string())?;
        std::fs::write(self.staged_meta(), json!({"version": latest, "sha256": expected}).to_string()).map_err(|e| e.to_string())?;
        self.set(|s| {
            s.state = "ready".into();
            s.progress = 1.0;
        });
        Ok(())
    }
}

/// Newest standalone release for the channel; "stable" ignores pre-releases (test builds).
pub fn pick_release<'a>(rels: &'a [Value], channel: &str) -> Option<&'a Value> {
    rels.iter()
        .filter(|r| r["tag_name"].as_str().map(|t| t.starts_with(TAG_PREFIX)).unwrap_or(false))
        .filter(|r| !r["draft"].as_bool().unwrap_or(false))
        .filter(|r| channel == "dev" || !r["prerelease"].as_bool().unwrap_or(false))
        .fold(None, |best: Option<&Value>, r| match best {
            Some(b) if !is_newer(r["tag_name"].as_str().unwrap_or(""), b["tag_name"].as_str().unwrap_or("")) => Some(b),
            _ => Some(r),
        })
}

/// Windows keeps a program's icon in its icon cache, and pinned taskbar buttons and shortcuts show
/// that cached copy, so a new icon in an updated exe would not appear until the cache is rebuilt.
/// Tell the shell that this file and the icons changed, and refresh the icon cache.
#[cfg(windows)]
pub fn refresh_shell_icons(exe: &std::path::Path) {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::process::CommandExt;
    #[link(name = "shell32")]
    extern "system" {
        fn SHChangeNotify(event: i32, flags: u32, item1: *const core::ffi::c_void, item2: *const core::ffi::c_void);
    }
    const SHCNE_UPDATEITEM: i32 = 0x0000_2000;
    const SHCNE_ASSOCCHANGED: i32 = 0x0800_0000;
    const SHCNF_IDLIST: u32 = 0x0000;
    const SHCNF_PATHW: u32 = 0x0005;
    const SHCNF_FLUSHNOWAIT: u32 = 0x3000;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let wide: Vec<u16> = exe.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        SHChangeNotify(SHCNE_UPDATEITEM, SHCNF_PATHW | SHCNF_FLUSHNOWAIT, wide.as_ptr().cast(), std::ptr::null());
        SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST | SHCNF_FLUSHNOWAIT, std::ptr::null(), std::ptr::null());
    }
    // Windows 10/11: rebuilds the user's icon cache (what pinned taskbar buttons use). Best effort.
    if let Some(root) = std::env::var_os("SystemRoot") {
        let tool = std::path::Path::new(&root).join("System32").join("ie4uinit.exe");
        if tool.exists() {
            let _ = std::process::Command::new(tool).arg("-show").creation_flags(CREATE_NO_WINDOW).spawn();
        }
    }
}

#[cfg(not(windows))]
pub fn refresh_shell_icons(_exe: &std::path::Path) {}

fn check_host(u: &str) -> Result<(), String> {
    let url = url::Url::parse(u).map_err(|_| "bad url")?;
    let host = url.host_str().unwrap_or("");
    if url.scheme() != "https" || !ALLOWED_HOSTS.contains(&host) {
        return Err(format!("Refusing to download an update from {host}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn versions() {
        assert!(is_newer("standalone-v0.2.5", "0.1.9"));
        assert!(!is_newer("0.1.9", "0.1.10"));
        assert!(is_newer("1.0", "0.9.99"));
        assert!(!is_newer("garbage", "0.1.0"));
        assert!(check_host("https://evil.example/x").is_err());
        assert!(check_host("https://github.com/x").is_ok());
    }

    #[test]
    fn channels() {
        let rels = serde_json::json!([
            {"tag_name": "browser-v9.0.0", "prerelease": false},
            {"tag_name": "standalone-v0.2.5", "prerelease": false},
            {"tag_name": "standalone-v0.2.9-dev", "prerelease": true},
            {"tag_name": "standalone-v0.2.7", "prerelease": false},
        ]);
        let rels = rels.as_array().unwrap();
        assert_eq!(pick_release(rels, "stable").unwrap()["tag_name"], "standalone-v0.2.7");
        assert_eq!(pick_release(rels, "dev").unwrap()["tag_name"], "standalone-v0.2.9-dev");
    }
}
