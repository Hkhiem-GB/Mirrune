mod adb;
pub mod connection;
pub(crate) mod media;
pub(crate) mod media_transport;
pub(crate) mod scrcpy;
pub(crate) mod tools;

use serde::Serialize;

pub use tools::AndroidTools;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidDevice {
    pub serial: String,
    pub state: String,
    pub manufacturer: Option<String>,
    pub model: Option<String>,
    pub android_version: Option<String>,
    pub resolution: Option<String>,
    pub product: Option<String>,
}
