mod android;

use android::connection::AndroidConnection;
use tauri::{Manager, State};

#[tauri::command]
async fn list_android_devices(
    connection: State<'_, AndroidConnection>,
) -> Result<Vec<android::AndroidDevice>, String> {
    let manager = connection.inner().clone();

    tauri::async_runtime::spawn_blocking(move || manager.list_devices())
        .await
        .map_err(|error| format!("Lỗi quét thiết bị: {error}"))?
}

#[tauri::command]
async fn connect_android_device(
    serial: String,
    connection: State<'_, AndroidConnection>,
) -> Result<String, String> {
    let manager = connection.inner().clone();

    tauri::async_runtime::spawn_blocking(move || manager.connect(serial))
        .await
        .map_err(|error| format!("Lỗi kết nối thiết bị: {error}"))?
}

#[tauri::command]
fn disconnect_android_device(connection: State<'_, AndroidConnection>) -> Result<(), String> {
    connection.disconnect()
}

#[tauri::command]
fn get_active_android_device(
    connection: State<'_, AndroidConnection>,
) -> Result<Option<String>, String> {
    connection.current()
}

#[tauri::command]
fn get_android_session(
    connection: State<'_, AndroidConnection>,
) -> Result<android::connection::AndroidSessionInfo, String> {
    connection.status()
}

#[tauri::command]
fn get_android_media_info(
    connection: State<'_, AndroidConnection>,
) -> Result<Option<android::scrcpy::ScrcpyMediaInfo>, String> {
    connection.media_info()
}

#[tauri::command]
fn mark_android_streaming(connection: State<'_, AndroidConnection>) -> Result<(), String> {
    connection.mark_streaming()
}

#[tauri::command]
async fn refresh_android_connection(
    connection: State<'_, AndroidConnection>,
) -> Result<Option<String>, String> {
    let manager = connection.inner().clone();

    let Some(serial) = manager.current()? else {
        return Ok(None);
    };

    let check_serial = serial.clone();
    let checker = manager.clone();
    let is_connected =
        tauri::async_runtime::spawn_blocking(move || checker.is_device_ready(&check_serial))
            .await
            .map_err(|error| format!("Lỗi kiểm tra thiết bị: {error}"))??;

    if !is_connected {
        manager.disconnect()?;
        return Ok(None);
    }

    Ok(Some(serial))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let resource_dir = app.path().resource_dir()?;
            app.manage(AndroidConnection::with_resource_dir(resource_dir));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_android_devices,
            connect_android_device,
            disconnect_android_device,
            get_active_android_device,
            get_android_session,
            get_android_media_info,
            mark_android_streaming,
            refresh_android_connection
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
