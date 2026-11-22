use super::{
    AndroidTools,
    scrcpy::{ScrcpyMediaInfo, ScrcpyRuntime},
};
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AndroidSessionStatus {
    Disconnected,
    Connecting,
    Connected,
    Streaming,
    Disconnecting,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidSessionInfo {
    pub status: AndroidSessionStatus,
    pub serial: Option<String>,
    pub error: Option<String>,
}

impl Default for AndroidSessionInfo {
    fn default() -> Self {
        Self {
            status: AndroidSessionStatus::Disconnected,
            serial: None,
            error: None,
        }
    }
}

#[derive(Clone)]
pub struct AndroidConnection {
    tools: AndroidTools,
    session: Arc<Mutex<AndroidSessionInfo>>,
    runtime: Arc<Mutex<Option<ScrcpyRuntime>>>,
}

impl AndroidConnection {
    pub fn with_resource_dir(resource_dir: PathBuf) -> Self {
        Self::with_tools(AndroidTools::from_resource_dir(&resource_dir))
    }

    fn with_tools(tools: AndroidTools) -> Self {
        Self {
            tools,
            session: Arc::default(),
            runtime: Arc::default(),
        }
    }

    pub fn list_devices(&self) -> Result<Vec<super::AndroidDevice>, String> {
        super::adb::list_devices(self.tools.adb())
    }

    pub fn is_device_ready(&self, serial: &str) -> Result<bool, String> {
        super::adb::is_device_ready(self.tools.adb(), serial)
    }

    pub fn connect(&self, serial: String) -> Result<String, String> {
        let mut session = self
            .session
            .lock()
            .map_err(|_| "Không thể truy cập trạng thái kết nối".to_string())?;

        match session.status {
            AndroidSessionStatus::Connecting | AndroidSessionStatus::Disconnecting => {
                return Err("Đang xử lý một thao tác kết nối khác.".to_string());
            }

            AndroidSessionStatus::Connected | AndroidSessionStatus::Streaming => {
                if session.serial.as_deref() == Some(&serial) {
                    return Ok(serial);
                }

                return Err(format!(
                    "Đang có thiết bị {} được kết nối. \
                    Hãy ngắt kết nối trước khi chọn thiết bị khác.",
                    session.serial.as_deref().unwrap_or("không xác định")
                ));
            }

            AndroidSessionStatus::Disconnected | AndroidSessionStatus::Error => {}
        }

        session.status = AndroidSessionStatus::Connecting;
        session.serial = Some(serial.clone());
        session.error = None;

        if let Err(error) = super::adb::verify_device(self.tools.adb(), &serial) {
            session.status = AndroidSessionStatus::Error;
            session.serial = None;
            session.error = Some(error.clone());

            return Err(error);
        }

        let runtime = match ScrcpyRuntime::start(&serial, &self.tools) {
            Ok(runtime) => runtime,
            Err(error) => {
                session.status = AndroidSessionStatus::Error;
                session.serial = None;
                session.error = Some(error.clone());

                return Err(error);
            }
        };

        let mut active_runtime = self
            .runtime
            .lock()
            .map_err(|_| "Không thể quản lý scrcpy runtime".to_string())?;

        *active_runtime = Some(runtime);

        session.status = AndroidSessionStatus::Connected;

        Ok(serial)
    }

    pub fn media_info(&self) -> Result<Option<ScrcpyMediaInfo>, String> {
        let runtime = self
            .runtime
            .lock()
            .map_err(|_| "Không thể truy cập media runtime".to_string())?;

        Ok(runtime.as_ref().map(ScrcpyRuntime::media_info))
    }

    pub fn disconnect(&self) -> Result<(), String> {
        {
            let mut session = self
                .session
                .lock()
                .map_err(|_| "Không thể truy cập trạng thái kết nối".to_string())?;

            if session.status == AndroidSessionStatus::Disconnected {
                return Ok(());
            }

            session.status = AndroidSessionStatus::Disconnecting;
        }

        let runtime = {
            let mut active_runtime = self
                .runtime
                .lock()
                .map_err(|_| "Không thể quản lý scrcpy runtime".to_string())?;

            active_runtime.take()
        };

        // Drop runtime sẽ dừng scrcpy và xóa ADB forward.
        drop(runtime);

        let mut session = self
            .session
            .lock()
            .map_err(|_| "Không thể truy cập trạng thái kết nối".to_string())?;

        session.serial = None;
        session.error = None;
        session.status = AndroidSessionStatus::Disconnected;

        Ok(())
    }

    pub fn mark_streaming(&self) -> Result<(), String> {
        let mut session = self
            .session
            .lock()
            .map_err(|_| "Không thể truy cập trạng thái kết nối".to_string())?;

        match session.status {
            AndroidSessionStatus::Connected => {
                session.status = AndroidSessionStatus::Streaming;
            }
            AndroidSessionStatus::Streaming => return Ok(()),
            _ => {
                return Err("Thiết bị chưa sẵn sàng để truyền media.".to_string());
            }
        }

        Ok(())
    }

    pub fn current(&self) -> Result<Option<String>, String> {
        let session = self
            .session
            .lock()
            .map_err(|_| "Không thể truy cập trạng thái kết nối".to_string())?;

        match session.status {
            AndroidSessionStatus::Connected | AndroidSessionStatus::Streaming => {
                Ok(session.serial.clone())
            }

            _ => Ok(None),
        }
    }

    pub fn status(&self) -> Result<AndroidSessionInfo, String> {
        let session = self
            .session
            .lock()
            .map_err(|_| "Không thể truy cập trạng thái kết nối".to_string())?;

        Ok(session.clone())
    }
}

impl Default for AndroidConnection {
    fn default() -> Self {
        Self::with_tools(AndroidTools::system())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mark_streaming_is_idempotent() {
        let connection = AndroidConnection::default();
        connection.session.lock().unwrap().status = AndroidSessionStatus::Connected;

        assert!(connection.mark_streaming().is_ok());
        assert!(connection.mark_streaming().is_ok());
        assert_eq!(
            connection.status().unwrap().status,
            AndroidSessionStatus::Streaming
        );
    }
}
