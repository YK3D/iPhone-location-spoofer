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
        // netmuxd logs only errors by default; "info" makes netmuxd.log useful in test reports.
        .env("RUST_LOG", std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into()))
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
    log_tail_n(6, 600)
}

/// The last `lines` lines of the helper's log, capped at `cap` characters.
fn log_tail_n(lines: usize, cap: usize) -> String {
    let text = std::fs::read_to_string(log_path()).unwrap_or_default();
    let last: Vec<&str> = text.lines().rev().take(lines).collect();
    let tail = last.into_iter().rev().collect::<Vec<_>>().join(" | ");
    if tail.is_empty() { "no output".into() } else { tail.chars().take(cap).collect() }
}

/// Helper-log lines about finding and opening the iPhone. The log's tail is usually a
/// device-list dump, which hides exactly the lines a test report needs, so pick them out.
fn log_device_lines() -> Vec<String> {
    let text = std::fs::read_to_string(log_path()).unwrap_or_default();
    const KEYS: [&str; 9] =
        ["apple_mux", "usb", "pair", "warn", "error", "listening", "trust", "serial", "lockdown"];
    let picked: Vec<&str> = text
        .lines()
        .filter(|l| {
            let s = l.to_lowercase();
            KEYS.iter().any(|k| s.contains(k))
        })
        .rev()
        .take(40)
        .collect();
    picked.into_iter().rev().map(|l| l.trim().chars().take(300).collect()).collect()
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

/// Device interface the Apple USB filter driver publishes for the iPhone's mux interface.
/// The built-in service enumerates exactly this GUID, so an empty result is the whole story:
/// the phone is not plugged in, or Apple's USB driver is not bound to it.
#[cfg(any(windows, test))]
const APPLE_MUX_INTERFACE_GUID: &str = "{664be590-54bd-4964-8a8c-6cd1314f6dc2}";

/// Subkeys of an interface-class key, one per registered interface instance. `reg query` echoes
/// the key it was given as `HKEY_LOCAL_MACHINE\...` whatever abbreviation was passed, and the
/// instance names end with the class GUID too, so match on the GUID followed by a separator.
#[cfg(any(windows, test))]
fn interface_instance_keys(listing: &str, guid: &str) -> Vec<String> {
    let marker = format!("{guid}\\");
    listing
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with("HKEY_") && l.contains(&marker))
        .map(String::from)
        .collect()
}

/// Whether `reg query ... /v Linked` reported `Linked` set. The value is 1 while the device
/// interface is live and 0 once the device is gone.
#[cfg(any(windows, test))]
fn linked_is_set(reg_output: &str) -> bool {
    reg_output.lines().any(|l| {
        let mut parts = l.split_whitespace();
        parts.next().is_some_and(|name| name.eq_ignore_ascii_case("Linked"))
            && parts.clone().any(|p| p.eq_ignore_ascii_case("REG_DWORD"))
            && parts.last().is_some_and(|v| {
                v.strip_prefix("0x").and_then(|h| u32::from_str_radix(h, 16).ok()).unwrap_or(0) != 0
            })
    })
}

/// Instances of the Apple mux device interface, and whether each is currently live.
#[cfg(windows)]
fn apple_mux_interface() -> Value {
    let root = format!(
        "HKLM\\SYSTEM\\CurrentControlSet\\Control\\DeviceClasses\\{APPLE_MUX_INTERFACE_GUID}"
    );
    let listing = run("reg", &["query", &root]).unwrap_or_default();
    let keys = interface_instance_keys(&listing, APPLE_MUX_INTERFACE_GUID);
    if keys.is_empty() {
        return json!({
            "guid": APPLE_MUX_INTERFACE_GUID,
            "registered": 0,
            "present": 0,
            "instances": [],
            "note": if listing.trim().is_empty() {
                "Apple's USB driver has never published this interface on this PC."
            } else {
                "The interface class exists but has no registered iPhone."
            },
        });
    }
    let mut instances = Vec::new();
    let mut present = 0usize;
    for key in keys {
        let live = run("reg", &["query", &key, "/s", "/v", "Linked"])
            .is_some_and(|o| linked_is_set(&o));
        if live {
            present += 1;
        }
        instances.push(json!({
            "instance": key.rsplit('\\').next().unwrap_or(&key),
            "present": live,
        }));
    }
    json!({
        "guid": APPLE_MUX_INTERFACE_GUID,
        "registered": instances.len(),
        "present": present,
        "instances": instances,
    })
}

/// Apple USB devices Windows knows about (VID_05AC), with their status and bound driver.
#[cfg(windows)]
fn apple_usb_devices() -> Vec<String> {
    let out = run("pnputil", &["/enum-devices", "/connected"]).unwrap_or_default();
    let mut devices = Vec::new();
    let mut block: Vec<&str> = Vec::new();
    for line in out.lines().chain(std::iter::once("")) {
        if line.trim().is_empty() {
            if block.iter().any(|l| l.to_uppercase().contains("VID_05AC")) {
                devices.push(block.iter().map(|l| l.trim()).collect::<Vec<_>>().join("; "));
            }
            block.clear();
        } else {
            block.push(line);
        }
    }
    if devices.is_empty() {
        // pnputil /enum-devices needs Windows 10 2004 or newer; fall back to PnP via PowerShell.
        let ps = run(
            "powershell",
            &[
                "-NoProfile",
                "-Command",
                r#"Get-PnpDevice | Where-Object { $_.InstanceId -like '*VID_05AC*' } | ForEach-Object { "Instance ID: $($_.InstanceId); Status: $($_.Status); Class: $($_.Class); Name: $($_.FriendlyName)" }"#,
            ],
        )
        .unwrap_or_default();
        devices.extend(ps.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from));
    }
    devices
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
        "builtin_service_log_path": log_path().display().to_string(),
        "builtin_service_log": if log_path().exists() { Some(log_tail_n(25, 2000)) } else { None },
        "builtin_service_device_log": if log_path().exists() { Some(log_device_lines()) } else { None },
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
        // The two checks that actually decide whether the built-in service can see the iPhone:
        // is the phone plugged in and bound to Apple's USB driver, and did that driver publish
        // the mux interface the built-in service looks for?
        d["apple_usb_devices"] = json!(apple_usb_devices());
        d["apple_mux_interface"] = apple_mux_interface();
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
        assert!(d.get("builtin_service_log_path").is_some());
    }

    #[test]
    fn reads_reg_query_output_for_the_mux_interface() {
        // `reg query` expands HKLM to HKEY_LOCAL_MACHINE and echoes the queried key first.
        let root = format!(
            "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\DeviceClasses\\{APPLE_MUX_INTERFACE_GUID}"
        );
        let listing = format!(
            "\n{root}\n\n{root}\\##?#USB#VID_05AC&PID_12A8&MI_01#6&1a2b#{APPLE_MUX_INTERFACE_GUID}\n"
        );
        let keys = interface_instance_keys(&listing, APPLE_MUX_INTERFACE_GUID);
        assert_eq!(keys.len(), 1, "the class key itself must not count as an instance");
        assert!(keys[0].contains("VID_05AC"));

        // No iPhone has ever registered: only the class key comes back.
        assert!(interface_instance_keys(&format!("\n{root}\n"), APPLE_MUX_INTERFACE_GUID).is_empty());
        assert!(interface_instance_keys("", APPLE_MUX_INTERFACE_GUID).is_empty());

        assert!(linked_is_set("    Linked    REG_DWORD    0x1"));
        assert!(!linked_is_set("    Linked    REG_DWORD    0x0"));
        assert!(!linked_is_set("ERROR: The system was unable to find the specified registry key"));
        assert!(!linked_is_set("    LinkedOther    REG_DWORD    0x1"));
    }

    #[test]
    fn device_log_lines_pick_usb_over_device_list_dumps() {
        let dir = std::env::temp_dir().join(format!("spoofer-log-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("SPOOFER_DATA_DIR", &dir);
        std::fs::write(
            log_path(),
            "INFO apple_mux enumerate found 0 interfaces\nDeviceList: [\n]\n}\n",
        )
        .unwrap();
        let picked = log_device_lines();
        assert_eq!(picked, vec!["INFO apple_mux enumerate found 0 interfaces".to_string()]);
        assert!(log_tail_n(3, 600).contains("DeviceList"));
        std::env::remove_var("SPOOFER_DATA_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
