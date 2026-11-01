//! Ways this app can move a device's location: a real iPhone (idevice) or a simulator.

pub mod idev;
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

/// Owns both drivers; one is active.
pub struct DeviceManager {
    pub kind: DriverKind,
    pub idev: idev::IdeviceDriver,
    pub mock: mock::MockDriver,
}

impl Default for DeviceManager {
    fn default() -> Self {
        Self { kind: DriverKind::Idevice, idev: idev::IdeviceDriver::default(), mock: mock::MockDriver::default() }
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
    pub async fn connect(&mut self, kind: DriverKind, udid: Option<String>) -> Result<DeviceInfo, String> {
        if kind != self.kind {
            self.disconnect().await;
            self.kind = kind;
        }
        match kind {
            DriverKind::Idevice => self.idev.connect(udid).await,
            DriverKind::Mock => Ok(self.mock.connect()),
        }
    }
    pub async fn disconnect(&mut self) {
        match self.kind {
            DriverKind::Idevice => self.idev.disconnect().await,
            DriverKind::Mock => self.mock.info = None,
        }
    }
    pub async fn set_location(&mut self, lat: f64, lon: f64) -> Result<(), String> {
        match self.kind {
            DriverKind::Idevice => self.idev.set_location(lat, lon).await,
            DriverKind::Mock => self.mock.set_location(lat, lon),
        }
    }
    pub async fn clear_location(&mut self) -> Result<(), String> {
        match self.kind {
            DriverKind::Idevice => self.idev.clear_location().await,
            DriverKind::Mock => self.mock.clear_location(),
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
                let udid = self.idev.info.as_ref().map(|i| i.udid.clone()).ok_or("Connect first")?;
                let info = self.idev.connect(Some(udid)).await?;
                Ok(if info.notes.is_empty() { "Developer Disk Image is mounted.".into() } else { info.notes.join(" ") })
            }
            DriverKind::Mock => Ok("Simulator: nothing to mount.".into()),
        }
    }
}
