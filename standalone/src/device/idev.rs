//! Real iPhone driver built on the `idevice` crate (MIT), no Python and no admin rights.
//!
//! * Device discovery and pairing go through usbmuxd: Apple's Mobile Device Service on Windows
//!   (127.0.0.1:27015, from the Apple Devices app or iTunes), usbmuxd on Linux, the system one
//!   on macOS. `USBMUXD_SOCKET_ADDRESS` points it at a replacement such as netmuxd.
//! * iOS 17+: CoreDeviceProxy over lockdown (iOS 17.4+), a userspace TCP stack (no admin), RSD,
//!   then the DVT LocationSimulation channel.
//! * iOS 16 and older: lockdown `com.apple.dt.simulatelocation`.
//! * The Developer Disk Image is mounted automatically when missing, from the same public
//!   repository pymobiledevice3 uses (github.com/doronz88/DeveloperDiskImage).

use super::DeviceInfo;
use idevice::{
    IdeviceService, RsdService,
    amfi::AmfiClient,
    core_device_proxy::CoreDeviceProxy,
    dvt::{location_simulation::LocationSimulationClient, remote_server::RemoteServerClient},
    lockdown::LockdownClient,
    mobile_image_mounter::ImageMounter,
    provider::{IdeviceProvider, UsbmuxdProvider},
    rsd::RsdHandshake,
    services::simulate_location::LocationSimulationService,
    usbmuxd::{Connection, UsbmuxdAddr, UsbmuxdConnection},
    IdeviceError,
};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

const LABEL: &str = "location-spoofer";
const DDI_BASE: &str = "https://raw.githubusercontent.com/doronz88/DeveloperDiskImage/main";

enum Cmd {
    Set(f64, f64, oneshot::Sender<Result<(), String>>),
    Clear(oneshot::Sender<Result<(), String>>),
}

#[derive(Default)]
pub struct IdeviceDriver {
    pub info: Option<DeviceInfo>,
    tx: Option<mpsc::Sender<Cmd>>,
}

pub fn friendly(e: &IdeviceError) -> String {
    match e {
        IdeviceError::Socket(io) if matches!(io.kind(), std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::NotFound) => {
            "Cannot reach the Apple device service. On Windows, install the Apple Devices app (or iTunes) and keep it open.".into()
        }
        IdeviceError::PairingDialogResponsePending => "Tap Trust on the iPhone, enter the passcode, then try again.".into(),
        IdeviceError::UserDeniedPairing => "The iPhone refused to trust this computer. Unplug, plug back in and tap Trust.".into(),
        IdeviceError::PasswordProtected => "Unlock the iPhone and try again.".into(),
        IdeviceError::DeveloperModeNotEnabled => {
            "Developer Mode is off. Use 'Reveal Developer Mode', then turn it on in Settings › Privacy & Security.".into()
        }
        other => other.to_string(),
    }
}

fn addr() -> UsbmuxdAddr {
    UsbmuxdAddr::from_env_var().unwrap_or_else(|_| UsbmuxdAddr::default())
}

async fn usbmux() -> Result<UsbmuxdConnection, String> {
    addr().connect(1).await.map_err(|e| friendly(&e))
}

pub const WIFI_HELP: &str = "This iPhone can't be reached over Wi-Fi. Plug it in once, press Device tools › Allow Wi-Fi \
                             connection, then keep it unlocked and on the same network as this computer.";

fn is_usb(c: &Connection) -> bool {
    matches!(c, Connection::Usb)
}

fn conn_label(c: &Connection) -> &'static str {
    match c {
        Connection::Usb => "USB",
        Connection::Network(_) => "Wi-Fi",
        Connection::Unknown(_) => "Other",
    }
}

/// The phone to talk to, over the chosen connection: `Auto` takes the cable when the phone is
/// plugged in, else Wi-Fi. usbmuxd lists a phone that is both plugged in and on Wi-Fi twice.
async fn find_device(udid: Option<&str>, via: super::Via) -> Result<(UsbmuxdProvider, String), String> {
    use super::Via;
    let mut mux = usbmux().await?;
    let devices = mux.get_devices().await.map_err(|e| friendly(&e))?;
    let wanted = |d: &&idevice::usbmuxd::UsbmuxdDevice| {
        udid.is_none_or(|u| u.is_empty() || d.udid == u)
            && match via {
                Via::Auto => true,
                Via::Usb => is_usb(&d.connection_type),
                Via::Network => matches!(d.connection_type, Connection::Network(_)),
            }
    };
    let dev = devices.iter().filter(wanted).find(|d| is_usb(&d.connection_type)).or_else(|| devices.iter().find(wanted)).cloned();
    let dev = dev.ok_or(match via {
        super::Via::Network => WIFI_HELP,
        _ => "No iPhone found. Plug it in with a cable, unlock it and tap Trust.",
    })?;
    let conn = match &dev.connection_type {
        Connection::Usb => "USB".to_string(),
        Connection::Network(ip) => format!("Wi-Fi ({ip})"),
        Connection::Unknown(s) => s.clone(),
    };
    Ok((dev.to_provider(addr(), LABEL), conn))
}

pub async fn list_devices() -> Result<Vec<serde_json::Value>, String> {
    let mut mux = usbmux().await?;
    let mut devices = mux.get_devices().await.map_err(|e| friendly(&e))?;
    // one entry per phone (the cable first), naming every way it can be reached
    devices.sort_by_key(|d| !is_usb(&d.connection_type));
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for d in devices.iter() {
        if !seen.insert(d.udid.clone()) {
            continue;
        }
        let mut conns: Vec<&str> = Vec::new();
        for o in devices.iter().filter(|o| o.udid == d.udid) {
            let l = conn_label(&o.connection_type);
            if !conns.contains(&l) {
                conns.push(l);
            }
        }
        let provider = d.to_provider(addr(), LABEL);
        let mut entry = serde_json::json!({"udid": d.udid, "name": "", "ios_version": "",
            "connection": conns.join(" + "), "connections": conns});
        match LockdownClient::connect(&provider).await {
            Ok(mut ld) => {
                if let Ok(v) = ld.get_value(Some("ProductVersion"), None).await {
                    entry["ios_version"] = serde_json::json!(v.as_string().unwrap_or(""));
                }
                if let Ok(v) = ld.get_value(Some("DeviceName"), None).await {
                    entry["name"] = serde_json::json!(v.as_string().unwrap_or(""));
                }
            }
            Err(e) => entry["error"] = serde_json::json!(friendly(&e)),
        }
        out.push(entry);
    }
    Ok(out)
}

/// Pair if this computer has no pairing record for the phone yet (shows "Trust This Computer?").
async fn ensure_paired(provider: &UsbmuxdProvider) -> Result<(), String> {
    if provider.get_pairing_file().await.is_ok() {
        return Ok(());
    }
    let mut ld = LockdownClient::connect(provider).await.map_err(|e| friendly(&e))?;
    let buid = usbmux().await?.get_buid().await.map_err(|e| friendly(&e))?;
    let host_id = random_uuid();
    let pf = ld.pair(host_id, buid, Some("Location Spoofer")).await.map_err(|e| friendly(&e))?;
    let bytes = pf.serialize().map_err(|e| friendly(&e))?;
    usbmux().await?.save_pair_record(&provider.udid, bytes).await.map_err(|e| friendly(&e))
}

fn random_uuid() -> String {
    use rand::Rng;
    let b: [u8; 16] = rand::thread_rng().gen();
    format!(
        "{:08X}-{:04X}-{:04X}-{:04X}-{:012X}",
        u32::from_be_bytes([b[0], b[1], b[2], b[3]]),
        u16::from_be_bytes([b[4], b[5]]),
        (u16::from_be_bytes([b[6], b[7]]) & 0x0fff) | 0x4000,
        (u16::from_be_bytes([b[8], b[9]]) & 0x3fff) | 0x8000,
        u64::from_be_bytes([0, 0, b[10], b[11], b[12], b[13], b[14], b[15]])
    )
}

fn major(v: &str) -> u32 {
    v.split('.').next().and_then(|x| x.parse().ok()).unwrap_or(0)
}

async fn download(path: &str) -> Result<Vec<u8>, String> {
    let cache = crate::store::data_dir().join("ddi").join(path.replace('/', "_"));
    if let Ok(b) = tokio::fs::read(&cache).await {
        if !b.is_empty() {
            return Ok(b);
        }
    }
    let url = format!("{DDI_BASE}/{path}");
    let r = crate::routing::http().get(&url).send().await.map_err(|e| format!("Could not download the Developer Disk Image: {e}"))?;
    if !r.status().is_success() {
        return Err(format!("Developer Disk Image not available ({} for {path})", r.status().as_u16()));
    }
    let bytes = r.bytes().await.map_err(|e| e.to_string())?.to_vec();
    if let Some(dir) = cache.parent() {
        let _ = tokio::fs::create_dir_all(dir).await;
    }
    let _ = tokio::fs::write(&cache, &bytes).await;
    Ok(bytes)
}

/// Mount the Developer Disk Image if it is not mounted yet. Returns a note for the user.
async fn ensure_ddi(provider: &UsbmuxdProvider, version: &str, chip_id: Option<u64>) -> Result<Option<String>, String> {
    let mut mounter = ImageMounter::connect(provider).await.map_err(|e| friendly(&e))?;
    let personalized = major(version) >= 17;
    let kind = if personalized { "Personalized" } else { "Developer" };
    if mounter.lookup_image(kind).await.map(|s| !s.is_empty()).unwrap_or(false) {
        return Ok(None);
    }
    if major(version) >= 27 {
        return Err("iOS 27+ installs the developer image as a cryptex, which this version cannot do yet. \
                    Mount it once with Xcode or pymobiledevice3, then connect again."
            .into());
    }
    if personalized {
        let image = download("PersonalizedImages/Xcode_iOS_DDI_Personalized/Image.dmg").await?;
        let manifest = download("PersonalizedImages/Xcode_iOS_DDI_Personalized/BuildManifest.plist").await?;
        let trust = download("PersonalizedImages/Xcode_iOS_DDI_Personalized/Image.dmg.trustcache").await?;
        let chip = chip_id.ok_or("Could not read the device's chip ID")?;
        mounter
            .mount_personalized(provider, image, trust, &manifest, None, chip)
            .await
            .map_err(|e| format!("Could not mount the Developer Disk Image: {}", friendly(&e)))?;
    } else {
        let mut parts: Vec<&str> = version.split('.').collect();
        parts.truncate(2);
        let ver = parts.join(".");
        let image = download(&format!("DeveloperDiskImages/{ver}/DeveloperDiskImage.dmg")).await?;
        let sig = download(&format!("DeveloperDiskImages/{ver}/DeveloperDiskImage.dmg.signature")).await?;
        mounter.mount_developer(&image, sig).await.map_err(|e| format!("Could not mount the Developer Disk Image: {}", friendly(&e)))?;
    }
    Ok(Some("Mounted the Developer Disk Image.".into()))
}

impl IdeviceDriver {
    pub async fn connect(&mut self, udid: Option<String>, via: super::Via) -> Result<DeviceInfo, String> {
        self.disconnect().await;
        let (provider, connection) = find_device(udid.as_deref(), via).await?;
        let real_udid = provider.udid.clone();
        ensure_paired(&provider).await?;
        let pairing = provider.get_pairing_file().await.map_err(|e| friendly(&e))?;
        let mut ld = LockdownClient::connect(&provider).await.map_err(|e| friendly(&e))?;
        ld.start_session(&pairing).await.map_err(|e| friendly(&e))?;
        let get = |v: Result<plist::Value, IdeviceError>| v.ok().and_then(|v| v.as_string().map(String::from)).unwrap_or_default();
        let version = get(ld.get_value(Some("ProductVersion"), None).await);
        let name = get(ld.get_value(Some("DeviceName"), None).await);
        let product = get(ld.get_value(Some("ProductType"), None).await);
        let chip = ld.get_value(Some("UniqueChipID"), None).await.ok().and_then(|v| v.as_unsigned_integer());
        drop(ld);

        let mut notes = Vec::new();
        match ensure_ddi(&provider, &version, chip).await {
            Ok(Some(n)) => notes.push(n),
            Ok(None) => {}
            Err(e) => notes.push(format!("{e} If setting a location fails, check Developer Mode and the internet connection.")),
        }

        let (tx, rx) = mpsc::channel::<Cmd>(32);
        let (ready_tx, ready_rx) = oneshot::channel::<Result<String, String>>();
        let modern = major(&version) >= 17;
        // Each phone session runs on its own thread with a single-threaded runtime: the idevice
        // RSD/DVT futures are not Send, and this keeps device I/O off the UI/HTTP threads.
        // The session ends when `tx` is dropped (disconnect) or the phone stops answering.
        std::thread::Builder::new()
            .name("iphone-session".into())
            .spawn(move || {
                let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                    Ok(rt) => rt,
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("Could not start the device thread: {e}")));
                        return;
                    }
                };
                rt.block_on(async move {
                    if modern {
                        session_dvt(provider, rx, ready_tx).await;
                    } else {
                        session_legacy(provider, rx, ready_tx).await;
                    }
                });
            })
            .map_err(|e| format!("Could not start the device thread: {e}"))?;
        let transport = match tokio::time::timeout(Duration::from_secs(60), ready_rx).await {
            Ok(Ok(Ok(t))) => t,
            Ok(Ok(Err(e))) => return Err(e),
            _ => return Err("Timed out connecting to the iPhone. Is it unlocked?".into()),
        };
        let info = DeviceInfo {
            udid: real_udid,
            name: if name.is_empty() { "iPhone".into() } else { name },
            ios_version: version,
            product_type: product,
            connection,
            transport,
            notes,
        };
        self.tx = Some(tx);
        self.info = Some(info.clone());
        Ok(info)
    }

    pub async fn disconnect(&mut self) {
        self.tx = None; // the session thread sees the closed channel and exits
        self.info = None;
    }

    async fn send(&mut self, make: impl FnOnce(oneshot::Sender<Result<(), String>>) -> Cmd) -> Result<(), String> {
        let tx = self.tx.as_ref().ok_or("Not connected")?.clone();
        let (rtx, rrx) = oneshot::channel();
        if tx.send(make(rtx)).await.is_err() {
            self.disconnect().await;
            return Err("Lost the connection to the iPhone. Connect again.".into());
        }
        match tokio::time::timeout(Duration::from_secs(20), rrx).await {
            Ok(Ok(Ok(()))) => Ok(()),
            Ok(Ok(Err(e))) => {
                self.disconnect().await;
                Err(format!("Lost the connection to the iPhone: {e}"))
            }
            _ => {
                self.disconnect().await;
                Err("The iPhone stopped answering. Connect again.".into())
            }
        }
    }

    pub async fn set_location(&mut self, lat: f64, lon: f64) -> Result<(), String> {
        self.send(|r| Cmd::Set(lat, lon, r)).await
    }

    pub async fn clear_location(&mut self) -> Result<(), String> {
        self.send(Cmd::Clear).await
    }
}

/// iOS 17+: tunnel + DVT. Owns every connection for the life of the session.
async fn session_dvt(provider: UsbmuxdProvider, mut rx: mpsc::Receiver<Cmd>, ready: oneshot::Sender<Result<String, String>>) {
    let setup = async {
        let proxy = CoreDeviceProxy::connect(&provider).await?;
        let rsd_port = proxy.tunnel_info().server_rsd_port;
        let adapter = proxy.create_software_tunnel()?;
        let mut adapter = adapter.to_async_handle();
        let stream = adapter.connect(rsd_port).await?;
        let mut handshake = RsdHandshake::new(stream).await?;
        let rs = RemoteServerClient::connect_rsd(&mut adapter, &mut handshake).await?;
        Ok::<_, IdeviceError>((adapter, rs))
    };
    let (adapter, mut rs) = match setup.await {
        Ok(x) => x,
        Err(e) => {
            let _ = ready.send(Err(match e {
                IdeviceError::Socket(_) | IdeviceError::NotFound => format!(
                    "Could not open the iOS 17+ developer tunnel ({}). iOS 17.0–17.3 is not supported by this version; \
                     update the iPhone or use the browser version.",
                    friendly(&e)
                ),
                other => friendly(&other),
            }));
            return;
        }
    };
    let _keep_adapter_alive = adapter;
    if let Err(e) = rs.read_message(0).await {
        let _ = ready.send(Err(friendly(&e)));
        return;
    }
    let mut ls = match LocationSimulationClient::new(&mut rs).await {
        Ok(c) => c,
        Err(e) => {
            let _ = ready.send(Err(format!("{} (is the Developer Disk Image mounted?)", friendly(&e))));
            return;
        }
    };
    let _ = ready.send(Ok("DVT over userspace tunnel (no admin)".into()));
    let mut last: Option<(f64, f64)> = None;
    loop {
        tokio::select! {
            cmd = rx.recv() => match cmd {
                None => break,
                Some(Cmd::Set(lat, lon, r)) => {
                    let res = ls.set(lat, lon).await.map_err(|e| friendly(&e));
                    if res.is_ok() { last = Some((lat, lon)); }
                    let failed = res.is_err();
                    let _ = r.send(res);
                    if failed { break; }
                }
                Some(Cmd::Clear(r)) => {
                    last = None;
                    let res = ls.clear().await.map_err(|e| friendly(&e));
                    let failed = res.is_err();
                    let _ = r.send(res);
                    if failed { break; }
                }
            },
            // Re-send the last position now and then, so the simulated fix stays fresh.
            _ = tokio::time::sleep(Duration::from_secs(4)) => {
                if let Some((lat, lon)) = last {
                    if ls.set(lat, lon).await.is_err() { break; }
                }
            }
        }
    }
}

/// iOS 16 and older: one lockdown service connection per command.
async fn session_legacy(provider: UsbmuxdProvider, mut rx: mpsc::Receiver<Cmd>, ready: oneshot::Sender<Result<String, String>>) {
    if let Err(e) = LocationSimulationService::connect(&provider).await {
        let _ = ready.send(Err(format!("{} (is the Developer Disk Image mounted?)", friendly(&e))));
        return;
    }
    let _ = ready.send(Ok("Lockdown simulatelocation".into()));
    while let Some(cmd) = rx.recv().await {
        match cmd {
            Cmd::Set(lat, lon, r) => {
                let res = async {
                    let mut s = LocationSimulationService::connect(&provider).await?;
                    s.set(&lat.to_string(), &lon.to_string()).await
                }
                .await
                .map_err(|e| friendly(&e));
                let _ = r.send(res);
            }
            Cmd::Clear(r) => {
                let res = async {
                    let mut s = LocationSimulationService::connect(&provider).await?;
                    s.clear().await
                }
                .await
                .map_err(|e| friendly(&e));
                let _ = r.send(res);
            }
        }
    }
}

/// Turns on the phone's "Show this iPhone when on Wi-Fi" setting (Wi-Fi sync), over the cable, so
/// it can be connected over Wi-Fi from then on.
pub async fn enable_wifi(udid: Option<String>) -> Result<String, String> {
    let (provider, _) = find_device(udid.as_deref(), super::Via::Usb)
        .await
        .map_err(|e| format!("Plug the iPhone in with a cable for this step. ({e})"))?;
    ensure_paired(&provider).await?;
    let pairing = provider.get_pairing_file().await.map_err(|e| friendly(&e))?;
    let mut ld = LockdownClient::connect(&provider).await.map_err(|e| friendly(&e))?;
    ld.start_session(&pairing).await.map_err(|e| friendly(&e))?;
    ld.set_value("EnableWifiConnections", true.into(), Some("com.apple.mobile.wireless_lockdown"))
        .await
        .map_err(|e| friendly(&e))?;
    Ok("Wi-Fi connections are on for this iPhone. Choose Wi-Fi in Device tools › Connect over, keep the phone \
        unlocked on the same network, and connect."
        .into())
}

pub async fn reveal_developer_mode(udid: Option<String>) -> Result<String, String> {
    let (provider, _) = find_device(udid.as_deref(), super::Via::Auto).await?;
    ensure_paired(&provider).await?;
    let mut amfi = AmfiClient::connect(&provider).await.map_err(|e| friendly(&e))?;
    amfi.reveal_developer_mode_option_in_ui().await.map_err(|e| friendly(&e))?;
    Ok("Done. On the iPhone open Settings › Privacy & Security › Developer Mode, switch it on and restart.".into())
}

#[cfg(test)]
mod tests {
    #[test]
    fn uuid_format() {
        let u = super::random_uuid();
        assert_eq!(u.len(), 36);
        assert_eq!(&u[14..15], "4");
    }
}
