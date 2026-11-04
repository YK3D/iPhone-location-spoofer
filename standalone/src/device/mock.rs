//! A pretend device, so the whole app can be tried (and tested) with no iPhone attached.

use super::DeviceInfo;

/// The pretend phones always report this iOS version (the current major release).
pub const SIMULATED_IOS: &str = "27";
/// Two pretend phones, so several iPhones at once can be tried without hardware.
pub const SIMULATED_DEVICES: [(&str, &str); 2] = [("SIMULATED-0001", "Simulated iPhone"), ("SIMULATED-0002", "Simulated iPhone 2")];

#[derive(Default)]
pub struct MockDriver {
    pub info: Option<DeviceInfo>,
    pub location: Option<(f64, f64)>,
    pub history: Vec<(f64, f64)>,
}

impl MockDriver {
    pub fn list_devices(&self) -> Vec<serde_json::Value> {
        SIMULATED_DEVICES
            .iter()
            .map(|(udid, name)| {
                serde_json::json!({"udid": udid, "name": name, "ios_version": SIMULATED_IOS,
                    "connection": "Simulated", "connections": ["Simulated"]})
            })
            .collect()
    }
    pub fn connect(&mut self, udid: Option<&str>) -> Result<DeviceInfo, String> {
        let (udid, name) = match udid.filter(|u| !u.is_empty()) {
            None => SIMULATED_DEVICES[0],
            Some(u) => *SIMULATED_DEVICES.iter().find(|(id, _)| *id == u).ok_or("No such simulated iPhone")?,
        };
        let info = DeviceInfo {
            udid: udid.into(),
            name: name.into(),
            ios_version: SIMULATED_IOS.into(),
            product_type: "Simulated".into(),
            connection: "Simulated".into(),
            transport: "In-memory (nothing is sent to a phone)".into(),
            notes: vec![],
        };
        self.info = Some(info.clone());
        Ok(info)
    }
    pub fn set_location(&mut self, lat: f64, lon: f64) -> Result<(), String> {
        if self.info.is_none() {
            return Err("Not connected".into());
        }
        self.location = Some((lat, lon));
        self.history.push((lat, lon));
        if self.history.len() > 10_000 {
            self.history.drain(..5_000);
        }
        Ok(())
    }
    pub fn clear_location(&mut self) -> Result<(), String> {
        self.location = None;
        Ok(())
    }
}
