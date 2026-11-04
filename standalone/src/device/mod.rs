//! Ways this app can move a device's location: a real iPhone (idevice) or a simulator.

pub mod idev;
pub mod mirror;
pub mod mock;

use serde::Serialize;

#[derive(Clone, Debug, Serialize, Default)]
pub struct DeviceInfo {
    pub udid: String,
    pub name: String,
    pub ios_version: String,
    pub product_type: String,
    pub connection: String,
    pub transport: String,
    pub notes: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DriverKind {
    Idevice,
    Mock,
}

impl DriverKind {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            // "pmd3" / "cli" are the browser version's names; both map to the direct driver here.
            "idevice" | "pmd3" | "cli" => Some(Self::Idevice),
            "mock" => Some(Self::Mock),
            _ => None,
        }
    }
    pub fn key(self) -> &'static str {
        match self {
            Self::Idevice => "pmd3",
            Self::Mock => "mock",
        }
    }
}

/// How to reach the phone: `Auto` takes the cable when it is plugged in, else Wi-Fi.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Via {
    #[default]
    Auto,
    Usb,
    Network,
}

impl Via {
    pub fn parse(s: Option<&str>) -> Option<Self> {
        match s.unwrap_or("auto") {
            "auto" | "" => Some(Self::Auto),
            "usb" => Some(Self::Usb),
            "network" => Some(Self::Network),
            _ => None,
        }
    }
}

/// Up to this many extra iPhones can follow the main one.
pub const MAX_MIRRORS: usize = 8;

/// Owns both drivers (one is active, the main phone) and the extra phones that follow it.
pub struct DeviceManager {
    pub kind: DriverKind,
    pub idev: idev::IdeviceDriver,
    pub mock: mock::MockDriver,
    pub mirrors: Vec<mirror::Mirror>,
    /// the last position sent to the main phone, so a new mirror can catch up at once
    last: Option<(f64, f64)>,
}

impl Default for DeviceManager {
    fn default() -> Self {
        Self {
            kind: DriverKind::Idevice,
            idev: idev::IdeviceDriver::default(),
            mock: mock::MockDriver::default(),
            mirrors: Vec::new(),
            last: None,
        }
    }
}

/// Connects another phone of the same kind as the main one, for use as a mirror. Runs without the
/// device lock held, so a slow iOS 17 handshake doesn't stall playback on the main phone.
pub async fn connect_mirror(kind: DriverKind, udid: String, via: Via) -> Result<(DeviceInfo, mirror::Backend), String> {
    match kind {
        DriverKind::Idevice => {
            let mut d = idev::IdeviceDriver::default();
            let info = d.connect(Some(udid), via).await?;
            Ok((info, mirror::Backend::Idevice(d)))
        }
        DriverKind::Mock => {
            let mut d = mock::MockDriver::default();
            let info = d.connect(Some(&udid))?;
            Ok((info, mirror::Backend::Mock(d)))
        }
    }
}

impl DeviceManager {
    pub fn info(&self) -> Option<DeviceInfo> {
        match self.kind {
            DriverKind::Idevice => self.idev.info.clone(),
            DriverKind::Mock => self.mock.info.clone(),
        }
    }
    pub fn connected(&self) -> bool {
        self.info().is_some()
    }
    pub async fn list_devices(&self, kind: DriverKind) -> Result<Vec<serde_json::Value>, String> {
        match kind {
            DriverKind::Idevice => idev::list_devices().await,
            DriverKind::Mock => Ok(self.mock.list_devices()),
        }
    }
    pub async fn connect(&mut self, kind: DriverKind, udid: Option<String>, via: Via) -> Result<DeviceInfo, String> {
        if kind != self.kind {
            self.disconnect().await;
            self.kind = kind;
        }
        if let Some(u) = udid.as_deref() {
            self.remove_mirror(u, false).await; // it becomes the main phone instead
        }
        let info = match kind {
            DriverKind::Idevice => self.idev.connect(udid, via).await?,
            DriverKind::Mock => self.mock.connect(udid.as_deref())?,
        };
        self.remove_mirror(&info.udid, false).await;
        Ok(info)
    }
    /// Disconnects the main phone and every mirror.
    pub async fn disconnect(&mut self) {
        self.drop_mirrors().await;
        self.disconnect_main().await;
    }
    async fn disconnect_main(&mut self) {
        self.last = None;
        match self.kind {
            DriverKind::Idevice => self.idev.disconnect().await,
            DriverKind::Mock => self.mock.info = None,
        }
    }
    pub async fn set_location(&mut self, lat: f64, lon: f64) -> Result<(), String> {
        match self.kind {
            DriverKind::Idevice => self.idev.set_location(lat, lon).await,
            DriverKind::Mock => self.mock.set_location(lat, lon),
        }?;
        self.last = Some((lat, lon));
        for m in &mut self.mirrors {
            m.push_set(lat, lon);
        }
        Ok(())
    }
    pub async fn clear_location(&mut self) -> Result<(), String> {
        match self.kind {
            DriverKind::Idevice => self.idev.clear_location().await,
            DriverKind::Mock => self.mock.clear_location(),
        }?;
        self.last = None;
        for m in &mut self.mirrors {
            m.push_clear();
        }
        Ok(())
    }

    /// Why `udid` can't become a mirror right now, if it can't.
    pub fn mirror_refusal(&self, udid: &str) -> Option<String> {
        let main = match self.info() {
            Some(i) => i,
            None => return Some("Connect the main iPhone first.".into()),
        };
        if udid == main.udid {
            return Some("That is the main iPhone already.".into());
        }
        if self.mirrors.iter().any(|m| m.info.udid == udid) {
            return Some("That iPhone already follows the main one.".into());
        }
        if self.mirrors.len() >= MAX_MIRRORS {
            return Some(format!("Up to {MAX_MIRRORS} extra iPhones can follow the main one."));
        }
        None
    }
    /// Adds a phone connected by `connect_mirror`; it moves to the main phone's position at once.
    pub async fn attach_mirror(&mut self, info: DeviceInfo, backend: mirror::Backend) -> Result<serde_json::Value, String> {
        if let Some(why) = self.mirror_refusal(&info.udid) {
            mirror::Mirror::start(info, backend).close(false).await;
            return Err(if why.starts_with("That is") { "That iPhone is connected already.".into() } else { why });
        }
        let mut m = mirror::Mirror::start(info, backend);
        if let Some((lat, lon)) = self.last {
            m.push_set(lat, lon);
        }
        let v = m.to_json();
        self.mirrors.push(m);
        Ok(v)
    }
    /// Stops a mirror; with `clear`, that phone goes back to its real location first.
    pub async fn remove_mirror(&mut self, udid: &str, clear: bool) -> bool {
        match self.mirrors.iter().position(|m| m.info.udid == udid) {
            Some(i) => {
                self.mirrors.remove(i).close(clear).await;
                true
            }
            None => false,
        }
    }
    pub async fn drop_mirrors(&mut self) {
        for m in std::mem::take(&mut self.mirrors) {
            m.close(false).await;
        }
    }
    pub fn mirrors_json(&self) -> Vec<serde_json::Value> {
        self.mirrors.iter().map(|m| m.to_json()).collect()
    }
    pub async fn enable_wifi(&mut self, udid: Option<String>) -> Result<String, String> {
        match self.kind {
            DriverKind::Idevice => idev::enable_wifi(udid.or_else(|| self.idev.info.as_ref().map(|i| i.udid.clone()))).await,
            DriverKind::Mock => Ok("Simulator: nothing to do.".into()),
        }
    }
    pub async fn reveal_developer_mode(&mut self) -> Result<String, String> {
        match self.kind {
            DriverKind::Idevice => idev::reveal_developer_mode(self.idev.info.as_ref().map(|i| i.udid.clone())).await,
            DriverKind::Mock => Ok("Simulator: nothing to reveal.".into()),
        }
    }
    pub async fn mount_developer_image(&mut self) -> Result<String, String> {
        match self.kind {
            DriverKind::Idevice => {
                let cur = self.idev.info.as_ref().ok_or("Connect first")?;
                let via = if cur.connection.starts_with("Wi-Fi") { Via::Network } else { Via::Auto };
                let udid = cur.udid.clone();
                let info = self.idev.connect(Some(udid), via).await?;
                Ok(if info.notes.is_empty() { "Developer Disk Image is mounted.".into() } else { info.notes.join(" ") })
            }
            DriverKind::Mock => Ok("Simulator: nothing to mount.".into()),
        }
    }
}
