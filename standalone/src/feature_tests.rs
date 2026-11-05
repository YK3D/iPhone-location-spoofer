//! Feature tests: encrypted builds of the pull requests into `feature-testing`, for the developer.
//!
//! CI builds each pull request, encrypts the exe and an index of builds with the developer
//! password (`.github/scripts/feature_test_seal.py`) and uploads them to the `feature-tests`
//! pre-release. Anyone can download those files, but only the password opens them: the app derives
//! the key with PBKDF2-HMAC-SHA256 and decrypts with AES-256-GCM, which also proves the files were
//! made with the password. A build is then started as its own app, in its own window, with its own
//! data folder and port, and without self-updating.
//!
//! File format: "LSFT1" | iterations (u32, big-endian) | salt (16) | nonce (12) | ciphertext + tag.
//! The same format is read by the browser edition (feature_tests.py).

use ring::{aead, pbkdf2};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::num::NonZeroU32;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub const RELEASE_TAG: &str = "feature-tests";
pub const MANIFEST: &str = "ft-index.bin";
pub const EXE_NAME: &str = "LocationSpooferStandalone.exe";
const MAGIC: &[u8; 5] = b"LSFT1";
const HEADER: usize = 5 + 4 + 16 + 12;
/// Files name their own PBKDF2 iteration count (CI uses 600,000); more than this is refused.
const MAX_ITERATIONS: u32 = 5_000_000;
const ALLOWED_HOSTS: [&str; 3] = ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"];

fn key_for(password: &str, salt: &[u8], iterations: u32) -> aead::LessSafeKey {
    let mut key = [0u8; 32];
    pbkdf2::derive(pbkdf2::PBKDF2_HMAC_SHA256, NonZeroU32::new(iterations).unwrap(), salt, password.as_bytes(), &mut key);
    aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, &key).expect("key length"))
}

/// Encrypt (used by the tests; CI encrypts with the Python script).
#[cfg(test)]
pub fn seal(password: &str, plain: &[u8], iterations: u32) -> Vec<u8> {
    let salt: [u8; 16] = rand::random();
    let nonce: [u8; 12] = rand::random();
    let mut out = Vec::with_capacity(HEADER + plain.len() + 16);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&iterations.to_be_bytes());
    out.extend_from_slice(&salt);
    out.extend_from_slice(&nonce);
    let mut buf = plain.to_vec();
    key_for(password, &salt, iterations)
        .seal_in_place_append_tag(aead::Nonce::assume_unique_for_key(nonce), aead::Aad::from(MAGIC), &mut buf)
        .expect("seal");
    out.extend_from_slice(&buf);
    out
}

/// Decrypt a file made by `seal` or the CI script. Fails for a wrong password or a changed file.
pub fn open(password: &str, data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < HEADER + 16 || &data[..5] != MAGIC {
        return Err("This is not a feature-test file.".into());
    }
    let iterations = u32::from_be_bytes(data[5..9].try_into().unwrap());
    if iterations == 0 || iterations > MAX_ITERATIONS {
        return Err("This is not a feature-test file.".into());
    }
    let salt = &data[9..25];
    let nonce: [u8; 12] = data[25..37].try_into().unwrap();
    let mut buf = data[HEADER..].to_vec();
    let plain = key_for(password, salt, iterations)
        .open_in_place(aead::Nonce::assume_unique_for_key(nonce), aead::Aad::from(MAGIC), &mut buf)
        .map_err(|_| "Wrong password.".to_string())?;
    Ok(plain.to_vec())
}

fn valid_asset(name: &str) -> bool {
    !name.is_empty() && name.len() <= 100 && name.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) && !name.starts_with('.')
}

pub type Launcher = Box<dyn Fn(&Path, &[String], &Path) -> Result<(), String> + Send + Sync>;

/// Start a downloaded build as its own app (Windows only: the builds are Windows programs).
pub fn launch_process(exe: &Path, args: &[String], data_dir: &Path) -> Result<(), String> {
    if !cfg!(windows) {
        return Err("Feature-test builds are Windows apps. Open them on a Windows PC.".into());
    }
    std::process::Command::new(exe)
        .args(args)
        .env("SPOOFER_DATA_DIR", data_dir)
        .current_dir(exe.parent().unwrap_or(Path::new(".")))
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Couldn't start the feature test: {e}"))
}

pub struct FeatureTests {
    dir: PathBuf,
    repo: String,
    /// Where releases are downloaded from (tests point this at a local server).
    base: String,
    password: Mutex<Option<String>>,
    launcher: Launcher,
    /// The last index opened, so "Open" starts a downloaded build without asking GitHub again.
    index: Mutex<Option<Value>>,
    /// Pull requests whose build is being downloaded in the background.
    downloading: Mutex<HashSet<u64>>,
    prefetching: AtomicBool,
    busy: tokio::sync::Mutex<()>,
}

/// Where one build lives once downloaded, and what it must hash to.
struct BuildFiles {
    pr: u64,
    asset: String,
    sha256: String,
    folder: PathBuf,
    exe: PathBuf,
}

impl FeatureTests {
    pub fn new(data_dir: &Path, repo: &str, launcher: Launcher) -> Arc<Self> {
        let me = Self {
            dir: data_dir.join("feature-tests"),
            repo: repo.into(),
            base: "https://github.com/".into(),
            password: Mutex::new(None),
            launcher,
            index: Mutex::new(None),
            downloading: Mutex::new(HashSet::new()),
            prefetching: AtomicBool::new(false),
            busy: tokio::sync::Mutex::new(()),
        };
        *me.password.lock().unwrap() = std::fs::read_to_string(me.key_file()).ok().map(|s| s.trim_end_matches(['\r', '\n']).to_string()).filter(|s| !s.is_empty());
        Arc::new(me)
    }

    fn key_file(&self) -> PathBuf {
        self.dir.join("access.key")
    }

    fn password(&self) -> Option<String> {
        self.password.lock().unwrap().clone()
    }

    async fn get(&self, asset: &str) -> Result<Vec<u8>, String> {
        let url = format!("{}{}/releases/download/{RELEASE_TAG}/{asset}", self.base, self.repo);
        let r = crate::routing::http().get(url).timeout(std::time::Duration::from_secs(300)).send().await.map_err(|e| format!("Couldn't reach GitHub: {e}"))?;
        let host = r.url().host_str().unwrap_or("").to_string();
        let allowed = (r.url().scheme() == "https" && ALLOWED_HOSTS.contains(&host.as_str())) || (cfg!(test) && host == "127.0.0.1");
        if !allowed {
            return Err(format!("Refusing to download from {host}"));
        }
        if r.status().as_u16() == 404 {
            return Err("No feature-test builds have been published yet.".into());
        }
        if !r.status().is_success() {
            return Err(format!("GitHub answered {}.", r.status().as_u16()));
        }
        Ok(r.bytes().await.map_err(|e| e.to_string())?.to_vec())
    }

    async fn decrypt(password: String, data: Vec<u8>) -> Result<Vec<u8>, String> {
        tokio::task::spawn_blocking(move || open(&password, &data)).await.map_err(|e| e.to_string())?
    }

    async fn manifest(&self, password: &str) -> Result<Value, String> {
        let plain = Self::decrypt(password.to_string(), self.get(MANIFEST).await?).await?;
        let v: Value = serde_json::from_slice(&plain).map_err(|_| "The feature-test index is damaged.")?;
        *self.index.lock().unwrap() = Some(v.clone());
        Ok(v)
    }

    fn files(&self, b: &Value) -> Result<BuildFiles, String> {
        let damaged = || "The feature-test index is damaged.".to_string();
        let pr = b["pr"].as_u64().ok_or_else(damaged)?;
        let asset = b["asset"].as_str().filter(|a| valid_asset(a)).ok_or_else(damaged)?.to_string();
        let sha256 = b["sha256"].as_str().filter(|s| s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())).ok_or_else(damaged)?.to_lowercase();
        let folder = self.dir.join("builds").join(format!("pr{pr}-{}", &sha256[..12]));
        Ok(BuildFiles { pr, asset, sha256, exe: folder.join(EXE_NAME), folder })
    }

    /// Downloaded and checked: "verified" is written only after the checksum matched.
    fn is_ready(f: &BuildFiles) -> bool {
        f.exe.is_file() && f.folder.join("verified").is_file()
    }

    /// The build's exe on disk, downloading, decrypting and checking it first if needed.
    async fn ensure(&self, pw: &str, b: &Value) -> Result<PathBuf, String> {
        let f = self.files(b)?;
        if Self::is_ready(&f) {
            return Ok(f.exe);
        }
        let plain = Self::decrypt(pw.to_string(), self.get(&f.asset).await?).await?;
        if hex::encode(Sha256::digest(&plain)) != f.sha256 {
            return Err("The downloaded build failed its checksum and was discarded.".into());
        }
        // older builds of the same pull request are no longer needed (skipped while running)
        if let Ok(rd) = std::fs::read_dir(self.dir.join("builds")) {
            for e in rd.flatten() {
                if e.file_name().to_string_lossy().starts_with(&format!("pr{}-", f.pr)) && e.path() != f.folder {
                    let _ = std::fs::remove_dir_all(e.path());
                }
            }
        }
        std::fs::create_dir_all(&f.folder).map_err(|e| e.to_string())?;
        let tmp = f.folder.join("download.part");
        std::fs::write(&tmp, &plain).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &f.exe).map_err(|e| e.to_string())?;
        std::fs::write(f.folder.join("verified"), &f.sha256).map_err(|e| e.to_string())?;
        Ok(f.exe)
    }

    fn public_list(&self, m: &Value) -> Value {
        let downloading = self.downloading.lock().unwrap().clone();
        let builds: Vec<Value> = m["builds"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|b| {
                let ready = self.files(b).map(|f| Self::is_ready(&f)).unwrap_or(false);
                let busy = b["pr"].as_u64().is_some_and(|pr| downloading.contains(&pr));
                json!({"pr": b["pr"], "title": b["title"], "url": b["url"], "state": b["state"], "built_at": b["built_at"],
                       "version": b["version"], "size": b["size"], "ready": ready, "downloading": busy})
            })
            .collect();
        json!({"locked": false, "builds": builds})
    }

    /// Download every build that isn't on this computer yet, one at a time in the background, so
    /// "Open" starts them straight away.
    fn prefetch(self: &Arc<Self>, pw: String, m: &Value) {
        let todo: Vec<Value> = m["builds"].as_array().into_iter().flatten().filter(|b| self.files(b).map(|f| !Self::is_ready(&f)).unwrap_or(false)).cloned().collect();
        if todo.is_empty() || self.prefetching.swap(true, Ordering::SeqCst) {
            return;
        }
        let me = self.clone();
        tokio::spawn(async move {
            for b in todo {
                let Some(pr) = b["pr"].as_u64() else { continue };
                me.downloading.lock().unwrap().insert(pr);
                let r = {
                    let _busy = me.busy.lock().await;
                    me.ensure(&pw, &b).await
                };
                me.downloading.lock().unwrap().remove(&pr);
                if let Err(e) = r {
                    tracing::warn!("feature test #{pr}: {e}");
                }
            }
            me.prefetching.store(false, Ordering::SeqCst);
        });
    }

    /// The list when unlocked (the password is in memory or remembered), else `{"locked": true}`.
    pub async fn list(self: &Arc<Self>) -> Result<Value, String> {
        let Some(pw) = self.password() else { return Ok(json!({"locked": true})) };
        let m = self.manifest(&pw).await?;
        self.prefetch(pw, &m);
        Ok(self.public_list(&m))
    }

    /// The list from the last index opened (no network): for showing download progress.
    pub fn progress(&self) -> Value {
        if self.password().is_none() {
            return json!({"locked": true});
        }
        let m = self.index.lock().unwrap().clone().unwrap_or_else(|| json!({"builds": []}));
        self.public_list(&m)
    }

    pub async fn unlock(self: &Arc<Self>, password: &str, remember: bool) -> Result<Value, String> {
        if password.is_empty() {
            return Err("Enter the developer password.".into());
        }
        let m = self.manifest(password).await?;
        *self.password.lock().unwrap() = Some(password.to_string());
        if remember {
            std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
            std::fs::write(self.key_file(), password).map_err(|e| e.to_string())?;
        }
        self.prefetch(password.to_string(), &m);
        Ok(self.public_list(&m))
    }

    pub fn lock(&self) {
        *self.password.lock().unwrap() = None;
        *self.index.lock().unwrap() = None;
        let _ = std::fs::remove_file(self.key_file());
    }

    /// Start a build in its own window (downloading it first if the background download hasn't).
    pub async fn open_build(&self, pr: u64) -> Result<Value, String> {
        let Some(pw) = self.password() else { return Err("Unlock feature tests first.".into()) };
        let find = |m: &Value| m["builds"].as_array().into_iter().flatten().find(|b| b["pr"].as_u64() == Some(pr)).cloned();
        let cached = self.index.lock().unwrap().as_ref().and_then(find);
        let b = match cached {
            Some(b) => b,
            None => find(&self.manifest(&pw).await?).ok_or("That feature test has no build.")?,
        };
        let exe = {
            let _busy = self.busy.lock().await;
            self.ensure(&pw, &b).await?
        };
        let args: Vec<String> = ["--port", "0", "--no-update", "--feature-test", &pr.to_string()].iter().map(|s| s.to_string()).collect();
        (self.launcher)(&exe, &args, &self.dir.join("data"))?;
        Ok(json!({"ok": true, "pr": pr, "title": b["title"]}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_and_open() {
        let data = seal("correct horse", b"hello build", 1000);
        assert_eq!(open("correct horse", &data).unwrap(), b"hello build");
        assert_eq!(open("wrong", &data).unwrap_err(), "Wrong password.");
        let mut changed = data.clone();
        let last = changed.len() - 1;
        changed[last] ^= 1;
        assert!(open("correct horse", &changed).is_err());
        assert!(open("x", b"LSFT1short").is_err());
    }

    #[test]
    fn python_format_matches() {
        // Made by .github/scripts/feature_test_seal.py (iterations 1000, password "pw").
        let hexdata = include_str!("../testdata/ft_sample.hex").trim();
        let data = hex::decode(hexdata).unwrap();
        assert_eq!(open("pw", &data).unwrap(), b"{\"builds\": []}");
    }

    #[test]
    fn asset_names() {
        assert!(valid_asset("ft-pr14.bin"));
        for bad in ["", "../x", ".hidden", "a/b", "a b"] {
            assert!(!valid_asset(bad), "{bad}");
        }
    }

    #[tokio::test]
    async fn locked_until_unlocked() {
        let dir = std::env::temp_dir().join(format!("spoofer-ft-{}", rand::random::<u32>()));
        let ft = FeatureTests::new(&dir, "YK3D/iPhone-location-spoofer", Box::new(|_, _, _| Ok(())));
        assert_eq!(ft.list().await.unwrap()["locked"], true);
        assert!(ft.open_build(1).await.unwrap_err().contains("Unlock"));
        assert!(ft.unlock("", false).await.is_err());
        // a remembered password is picked up at start, and forgotten by lock()
        std::fs::create_dir_all(dir.join("feature-tests")).unwrap();
        std::fs::write(dir.join("feature-tests/access.key"), "secret\n").unwrap();
        let ft = FeatureTests::new(&dir, "YK3D/iPhone-location-spoofer", Box::new(|_, _, _| Ok(())));
        assert_eq!(ft.password().as_deref(), Some("secret"));
        ft.lock();
        assert!(ft.password().is_none() && !dir.join("feature-tests/access.key").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A stand-in for the feature-tests release on a local port.
    async fn fake_release(files: Vec<(&'static str, Vec<u8>)>, hits: Arc<Mutex<Vec<String>>>) -> String {
        use axum::response::IntoResponse;
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        let files = Arc::new(files);
        let app = axum::Router::new().fallback(move |uri: axum::http::Uri| {
            let (files, hits) = (files.clone(), hits.clone());
            async move {
                let name = uri.path().rsplit('/').next().unwrap_or("").to_string();
                assert!(uri.path().starts_with("/YK3D/iPhone-location-spoofer/releases/download/feature-tests/"));
                hits.lock().unwrap().push(name.clone());
                match files.iter().find(|(n, _)| *n == name) {
                    Some((_, d)) => d.clone().into_response(),
                    None => axum::http::StatusCode::NOT_FOUND.into_response(),
                }
            }
        });
        tokio::spawn(async move { axum::serve(listener, app).await.ok() });
        base
    }

    #[tokio::test]
    async fn unlock_prefetches_and_opens_instantly() {
        let exe = b"MZ fake exe".to_vec();
        let index = json!({"builds": [{"pr": 14, "title": "New engine", "url": "https://github.com/x/y/pull/14", "asset": "ft-pr14.bin",
            "sha256": hex::encode(Sha256::digest(&exe)), "size": exe.len(), "state": "open", "built_at": "2026-11-05T10:00:00Z"}]});
        let hits = Arc::new(Mutex::new(Vec::new()));
        let base = fake_release(vec![("ft-index.bin", seal("s3cret", index.to_string().as_bytes(), 1000)), ("ft-pr14.bin", seal("s3cret", &exe, 1000))], hits.clone()).await;
        let dir = std::env::temp_dir().join(format!("spoofer-ft-e2e-{}", rand::random::<u32>()));
        type Launches = Arc<Mutex<Vec<(PathBuf, Vec<String>)>>>;
        let launched: Launches = Arc::new(Mutex::new(Vec::new()));
        let l2 = launched.clone();
        let mut ft = FeatureTests::new(&dir, "YK3D/iPhone-location-spoofer", Box::new(move |exe, args, _| {
            l2.lock().unwrap().push((exe.to_path_buf(), args.to_vec()));
            Ok(())
        }));
        Arc::get_mut(&mut ft).unwrap().base = base;
        assert_eq!(ft.unlock("wrong", false).await.unwrap_err(), "Wrong password.");
        let list = ft.unlock("s3cret", false).await.unwrap();
        assert_eq!(list["builds"][0]["pr"], 14);
        assert!(list["builds"][0].get("asset").is_none());
        // the background download makes the build ready
        for _ in 0..300 {
            if ft.progress()["builds"][0]["ready"] == true {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(ft.progress()["builds"][0]["ready"], true);
        hits.lock().unwrap().clear();
        ft.open_build(14).await.unwrap();
        assert!(hits.lock().unwrap().is_empty(), "opening a downloaded build needs no network");
        let (path, args) = launched.lock().unwrap()[0].clone();
        assert_eq!(std::fs::read(path).unwrap(), exe);
        assert_eq!(args, ["--port", "0", "--no-update", "--feature-test", "14"]);
        assert!(ft.open_build(99).await.is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
