//! A pretend device, so the whole app can be tried (and tested) with no iPhone attached.

use super::DeviceInfo;

#[derive(Default)]
pub struct MockDriver {
    pub info: Option<DeviceInfo>,
    pub location: Option<(f64, f64)>,
    pub history: Vec<(f64, f64)>,
}

impl MockDriver {
    pub fn list_devices(&self) -> Vec<serde_json::Value> {
        vec![serde_json::json!({"udid": "SIMULATED-0001", "name": "Simulated iPhone", "ios_version": "26.0", "connection": "Simulated"})]
    }
    pub fn connect(&mut self) -> DeviceInfo {
        let info = DeviceInfo {
            udid: "SIMULATED-0001".into(),
            name: "Simulated iPhone".into(),
            ios_version: "26.0".into(),
            product_type: "Simulated".into(),
            connection: "Simulated".into(),
            transport: "In-memory (nothing is sent to a phone)".into(),
            notes: vec![],
        };
        self.info = Some(info.clone());
        info
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
