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
use std::path::{Path, PathBuf};
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

fn asset_url(repo: &str, asset: &str) -> String {
    format!("https://github.com/{repo}/releases/download/{RELEASE_TAG}/{asset}")
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
    password: Mutex<Option<String>>,
    launcher: Launcher,
    busy: tokio::sync::Mutex<()>,
}

impl FeatureTests {
    pub fn new(data_dir: &Path, repo: &str, launcher: Launcher) -> Arc<Self> {
        let me = Self { dir: data_dir.join("feature-tests"), repo: repo.into(), password: Mutex::new(None), launcher, busy: tokio::sync::Mutex::new(()) };
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
        let r = crate::routing::http().get(asset_url(&self.repo, asset)).timeout(std::time::Duration::from_secs(300)).send().await.map_err(|e| format!("Couldn't reach GitHub: {e}"))?;
        let host = r.url().host_str().unwrap_or("").to_string();
        if r.url().scheme() != "https" || !ALLOWED_HOSTS.contains(&host.as_str()) {
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
        Ok(v)
    }

    fn public_list(m: &Value) -> Value {
        let builds: Vec<Value> = m["builds"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|b| json!({"pr": b["pr"], "title": b["title"], "url": b["url"], "state": b["state"], "built_at": b["built_at"], "version": b["version"], "size": b["size"]}))
            .collect();
        json!({"locked": false, "builds": builds})
    }

    /// The list when unlocked (the password is in memory or remembered), else `{"locked": true}`.
    pub async fn list(&self) -> Result<Value, String> {
        let Some(pw) = self.password() else { return Ok(json!({"locked": true})) };
        Ok(Self::public_list(&self.manifest(&pw).await?))
    }

    pub async fn unlock(&self, password: &str, remember: bool) -> Result<Value, String> {
        if password.is_empty() {
            return Err("Enter the developer password.".into());
        }
        let m = self.manifest(password).await?;
        *self.password.lock().unwrap() = Some(password.to_string());
        if remember {
            std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
            std::fs::write(self.key_file(), password).map_err(|e| e.to_string())?;
        }
        Ok(Self::public_list(&m))
    }

    pub fn lock(&self) {
        *self.password.lock().unwrap() = None;
        let _ = std::fs::remove_file(self.key_file());
    }

    /// Download (once), decrypt and verify a build, then start it in its own window.
    pub async fn open_build(&self, pr: u64) -> Result<Value, String> {
        let Some(pw) = self.password() else { return Err("Unlock feature tests first.".into()) };
        let _busy = self.busy.lock().await;
        let m = self.manifest(&pw).await?;
        let b = m["builds"].as_array().into_iter().flatten().find(|b| b["pr"].as_u64() == Some(pr)).ok_or("That feature test has no build.")?;
        let asset = b["asset"].as_str().filter(|a| valid_asset(a)).ok_or("The feature-test index is damaged.")?;
        let sum = b["sha256"].as_str().filter(|s| s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())).ok_or("The feature-test index is damaged.")?.to_lowercase();
        let folder = self.dir.join("builds").join(format!("pr{pr}-{}", &sum[..12]));
        let exe = folder.join(EXE_NAME);
        let ok = std::fs::read(&exe).map(|d| hex::encode(Sha256::digest(&d)) == sum).unwrap_or(false);
        if !ok {
            let plain = Self::decrypt(pw, self.get(asset).await?).await?;
            if hex::encode(Sha256::digest(&plain)) != sum {
                return Err("The downloaded build failed its checksum and was discarded.".into());
            }
            // older builds of the same pull request are no longer needed (skipped while running)
            if let Ok(rd) = std::fs::read_dir(self.dir.join("builds")) {
                for e in rd.flatten() {
                    if e.file_name().to_string_lossy().starts_with(&format!("pr{pr}-")) && e.path() != folder {
                        let _ = std::fs::remove_dir_all(e.path());
                    }
                }
            }
            std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
            let tmp = folder.join("download.part");
            std::fs::write(&tmp, &plain).map_err(|e| e.to_string())?;
            std::fs::rename(&tmp, &exe).map_err(|e| e.to_string())?;
        }
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
}
