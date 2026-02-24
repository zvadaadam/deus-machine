use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimulatorInfo {
    pub name: String,
    pub udid: String,
    pub state: String,
    pub runtime: String,
    pub device_type: String,
    pub is_available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamInfo {
    pub url: String,
    pub port: u16,
    /// Whether HID client is available for touch/scroll/key injection.
    /// If false, touch interaction with the simulator will not work.
    pub hid_available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledApp {
    pub bundle_id: String,
    pub name: String,
    pub app_path: String,
}
