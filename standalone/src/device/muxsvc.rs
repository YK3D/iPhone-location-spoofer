//! EXPERIMENTAL: run without the Apple Devices app.
//!
//! On Windows, iPhone access normally goes through Apple's "Apple Mobile Device Service"
//! (installed by the Apple Devices app or iTunes), which listens on 127.0.0.1:27015. This module
//! can start a bundled copy of netmuxd (LGPL-2.1, a separate helper program shipped next to the
//! app) in its place. netmuxd talks to Apple's USB driver directly, so only that driver (which
//! Windows Update can install) is needed — not the Apple Devices app.
//!
//! Modes (Settings › Device service):
//! * `auto`    — use Apple's service if it is running, otherwise start the built-in one.
//! * `apple`   — only use Apple's service (the stable behaviour).
//! * `builtin` — always use the built-in service. If Apple's service is also running, the
//!               built-in one listens on 127.0.0.1:27016 instead (both may compete for the phone).

use idevice::usbmuxd::UsbmuxdAddr;
use serde_json::{json, Value};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const APPLE_PORT: u16 = 27015;
pub const ALT_PORT: u16 = 27016;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Auto,
    Apple,
    Builtin,
}

impl Mode {
    pub fn parse(s: &str) -> Self {
        match s {
            "builtin" => Self::Builtin,
            "apple" => Self::Apple,
            _ => Self::Auto,
        }
    }
}

struct Helper {
    child: Child,
    port: u16,
}

static HELPER: Mutex<Option<Helper>> = Mutex::new(None);
static OVERRIDE: Mutex<Option<SocketAddr>> = Mutex::new(None);

/// The usbmuxd address the iPhone driver should use right now.
pub fn current_addr() -> UsbmuxdAddr {
    if let Some(a) = *OVERRIDE.lock().unwrap() {
        return UsbmuxdAddr::TcpSocket(a);
    }
    UsbmuxdAddr::from_env_var().unwrap_or_else(|_| UsbmuxdAddr::default())
}

fn set_override(port: Option<u16>) {
    *OVERRIDE.lock().unwrap() = port.map(|p| SocketAddr::from(([127, 0, 0, 1], p)));
}

pub fn port_open(port: u16) -> bool {
    TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(400)).is_ok()
}

/// Where the bundled helper is: next to the app, in `helpers/`, or `SPOOFER_NETMUXD`.
pub fn helper_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("SPOOFER_NETMUXD") {
        let p = PathBuf::from(p);
        return p.is_file().then_some(p);
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let name = if cfg!(windows) { "netmuxd.exe" } else { "netmuxd" };
    [dir.join(name), dir.join("helpers").join(name)].into_iter().find(|p| p.is_file())
}

fn helper_running() -> Option<u16> {
    let mut g = HELPER.lock().unwrap();
    if let Some(h) = g.as_mut() {
        match h.child.try_wait() {
            Ok(None) => return Some(h.port),
            _ => *g = None,
        }
    }
    None
}

fn log_path() -> PathBuf {
    crate::store::data_dir().join("netmuxd.log")
}

fn start_helper(port: u16) -> Result<(), String> {
    let exe = helper_path().ok_or(
        "The built-in device service (netmuxd) is not included in this build. \
         Use an experimental build, or set Device service to \"Apple's service\".",
    )?;
    let storage = crate::store::data_dir().join("pairing");
    std::fs::create_dir_all(&storage).map_err(|e| e.to_string())?;
    let log = std::fs::File::create(log_path()).map_err(|e| e.to_string())?;
    let log2 = log.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(&exe);
    cmd.args(["--host", "127.0.0.1", "--port", &port.to_string(), "--disable-mdns"])
        .arg("--plist-storage")
        .arg(&storage)
        .stdin(Stdio::null())
        .stdout(log)
        .stderr(log2);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| format!("Could not start the built-in device service: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("The built-in device service stopped ({status}). Details: {}", log_tail()));
        }
        if port_open(port) {
            *HELPER.lock().unwrap() = Some(Helper { child, port });
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    let _ = child.kill();
    Err(format!("The built-in device service did not start in time. Details: {}", log_tail()))
}

fn log_tail() -> String {
    let text = std::fs::read_to_string(log_path()).unwrap_or_default();
    let lines: Vec<&str> = text.lines().rev().take(6).collect();
    let tail = lines.into_iter().rev().collect::<Vec<_>>().join(" | ");
    if tail.is_empty() { "no output".into() } else { tail.chars().take(600).collect() }
}

pub fn shutdown() {
    if let Some(mut h) = HELPER.lock().unwrap().take() {
        let _ = h.child.kill();
        let _ = h.child.wait();
    }
    set_override(None);
}

/// Make sure a device service is reachable for `mode`. Returns a note for the user, if any.
pub fn ensure(mode: Mode) -> Result<Option<String>, String> {
    if std::env::var("USBMUXD_SOCKET_ADDRESS").is_ok() {
        return Ok(None); // the user pointed the app at a specific service
    }
    match mode {
        Mode::Apple => {
            shutdown();
            Ok(None)
        }
        Mode::Auto => {
            if let Some(p) = helper_running() {
                set_override(Some(p));
                return Ok(Some("Using the built-in device service (experimental).".into()));
            }
            if port_open(APPLE_PORT) {
                set_override(None);
                return Ok(None);
            }
            if helper_path().is_none() {
                return Ok(None); // nothing we can do; the connect error explains what to install
            }
            start_helper(APPLE_PORT)?;
            set_override(Some(APPLE_PORT));
            Ok(Some("Apple's device service isn't running, so the built-in service (experimental) is being used.".into()))
        }
        Mode::Builtin => {
            if let Some(p) = helper_running() {
                set_override(Some(p));
                return Ok(Some("Using the built-in device service (experimental).".into()));
            }
            let apple_up = port_open(APPLE_PORT);
            let port = if apple_up { ALT_PORT } else { APPLE_PORT };
            start_helper(port)?;
            set_override(Some(port));
            Ok(Some(if apple_up {
                "Using the built-in device service (experimental). Apple's service is also running and may keep the \
                 iPhone to itself; for a clean test, stop \"Apple Mobile Device Service\" or uninstall Apple Devices."
                    .into()
            } else {
                "Using the built-in device service (experimental).".into()
            }))
        }
    }
}

fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let mut c = Command::new(cmd);
    c.args(args).stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    let out = c.output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Facts for the "no Apple Devices app" test: what is installed and running.
pub fn diagnostics() -> Value {
    let helper = helper_path();
    #[allow(unused_mut)] // only written to on Windows
    let mut d = json!({
        "platform": std::env::consts::OS,
        "apple_service_port_open": port_open(APPLE_PORT),
        "builtin_service_running_on": helper_running(),
        "builtin_service_included": helper.is_some(),
        "builtin_service_path": helper.map(|p| p.display().to_string()),
        "usbmuxd_address_in_use": format!("{:?}", current_addr()),
        "builtin_service_log": if log_path().exists() { Some(log_tail()) } else { None },
    });
    #[cfg(windows)]
    {
        let sc = run("sc", &["query", "Apple Mobile Device Service"]).unwrap_or_default();
        let state = sc.lines().find(|l| l.contains("STATE")).map(|l| l.split_whitespace().last().unwrap_or("").to_string());
        d["apple_mobile_device_service"] = json!(state.unwrap_or_else(|| "not installed".into()));
        // Apple driver packages in the Windows driver store (from Windows Update or Apple's installer)
        let drivers = run("pnputil", &["/enum-drivers"]).unwrap_or_default();
        let mut apple = Vec::new();
        let mut block: Vec<&str> = Vec::new();
        for line in drivers.lines().chain(std::iter::once("")) {
            if line.trim().is_empty() {
                if block.iter().any(|l| l.contains("Apple")) {
                    apple.push(block.iter().map(|l| l.trim()).collect::<Vec<_>>().join("; "));
                }
                block.clear();
            } else {
                block.push(line);
            }
        }
        d["apple_driver_packages"] = json!(apple);
        let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        let filter = PathBuf::from(&sysroot).join("System32\\drivers\\UMDF\\AppleUsbFilter.dll");
        d["apple_usb_filter_dll"] = json!(filter.exists());
        let usbaapl = PathBuf::from(&sysroot).join("System32\\drivers\\usbaapl64.sys");
        d["apple_usbaapl64_sys"] = json!(usbaapl.exists());
        let apple_devices = run("powershell", &["-NoProfile", "-Command", "(Get-AppxPackage -Name *AppleDevices*).Name"]).unwrap_or_default();
        d["apple_devices_app"] = json!(!apple_devices.trim().is_empty());
    }
    #[cfg(not(windows))]
    {
        let _ = run;
    }
    d
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modes_and_override() {
        assert_eq!(Mode::parse("builtin"), Mode::Builtin);
        assert_eq!(Mode::parse("apple"), Mode::Apple);
        assert_eq!(Mode::parse("whatever"), Mode::Auto);
        set_override(Some(ALT_PORT));
        assert!(matches!(current_addr(), UsbmuxdAddr::TcpSocket(a) if a.port() == ALT_PORT));
        set_override(None);
    }

    #[test]
    fn builtin_without_helper_explains() {
        std::env::set_var("SPOOFER_NETMUXD", "/nonexistent/netmuxd");
        let err = ensure(Mode::Builtin).unwrap_err();
        assert!(err.contains("not included"));
        // Auto mode without a helper falls back silently
        assert!(ensure(Mode::Auto).is_ok());
        std::env::remove_var("SPOOFER_NETMUXD");
    }

    #[test]
    fn diagnostics_shape() {
        let d = diagnostics();
        assert!(d.get("apple_service_port_open").is_some());
        assert!(d.get("builtin_service_included").is_some());
    }
}
