use super::AndroidDevice;
use std::collections::HashMap;
use std::{
    io::{self, Read},
    path::Path,
    process::{Command, Output, Stdio},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const VERIFY_DEVICE_TIMEOUT: Duration = Duration::from_secs(15);

/// Thực thi một lệnh ADB và trả về stdout.
fn run_adb(adb: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new(adb)
        .args(args)
        .output()
        .map_err(|error| format!("Không thể khởi chạy ADB ({}): {error}", adb.display()))?;

    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();

        return Err(if error.is_empty() {
            format!("ADB thực thi thất bại với mã: {}", output.status)
        } else {
            format!("ADB thực thi thất bại: {error}")
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub(crate) fn run_command_with_timeout(
    program: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<Output, String> {
    let mut child = Command::new(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Không thể chạy {}: {error}", program.display()))?;

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("Không thể đọc stdout từ {}.", program.display()));
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("Không thể đọc stderr từ {}.", program.display()));
        }
    };

    let stdout_reader = read_child_output(stdout);
    let stderr_reader = read_child_output(stderr);
    let started = Instant::now();

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < timeout => {
                thread::sleep(Duration::from_millis(50));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                let _stdout = collect_child_output(stdout_reader, program, "stdout")?;
                let stderr = collect_child_output(stderr_reader, program, "stderr")?;
                let detail = String::from_utf8_lossy(&stderr).trim().to_string();
                let detail = if detail.is_empty() {
                    String::new()
                } else {
                    format!(" Chi tiết: {detail}")
                };

                return Err(format!(
                    "{} quá thời gian chờ {} giây khi chạy '{}'.{detail}",
                    program.display(),
                    timeout.as_secs(),
                    args.join(" ")
                ));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = collect_child_output(stdout_reader, program, "stdout")?;
                let _ = collect_child_output(stderr_reader, program, "stderr")?;
                return Err(format!(
                    "Không thể kiểm tra tiến trình {}: {error}",
                    program.display()
                ));
            }
        }
    };

    Ok(Output {
        status,
        stdout: collect_child_output(stdout_reader, program, "stdout")?,
        stderr: collect_child_output(stderr_reader, program, "stderr")?,
    })
}

fn read_child_output<R: Read + Send + 'static>(mut reader: R) -> JoinHandle<io::Result<Vec<u8>>> {
    thread::spawn(move || {
        let mut output = Vec::new();
        reader.read_to_end(&mut output)?;
        Ok(output)
    })
}

fn collect_child_output(
    reader: JoinHandle<io::Result<Vec<u8>>>,
    program: &Path,
    stream: &str,
) -> Result<Vec<u8>, String> {
    reader
        .join()
        .map_err(|_| format!("Tiến trình đọc {} {stream} bị lỗi.", program.display()))?
        .map_err(|error| format!("Không thể đọc {} {stream}: {error}", program.display()))
}

/// Đọc toàn bộ system properties trong một lần gọi ADB.
fn get_properties(adb: &Path, serial: &str) -> HashMap<String, String> {
    let Ok(output) = run_adb(adb, &["-s", serial, "shell", "getprop"]) else {
        return HashMap::new();
    };

    output
        .lines()
        .filter_map(|line| {
            let line = line.trim();

            let line = line.strip_prefix('[')?;
            let (key, value) = line.split_once("]: [")?;
            let value = value.strip_suffix(']')?;

            if key.is_empty() || value.is_empty() {
                return None;
            }

            Some((key.to_string(), value.to_string()))
        })
        .collect()
}

/// Lấy độ phân giải màn hình hiện tại.
fn get_resolution(adb: &Path, serial: &str) -> Option<String> {
    let output = run_adb(adb, &["-s", serial, "shell", "wm", "size"]).ok()?;

    output
        .lines()
        .filter_map(|line| line.split_once(':').map(|(_, value)| value.trim()))
        .filter(|value| !value.is_empty())
        .last()
        .map(String::from)
}

/// Phân tích metadata từ adb devices -l.
fn parse_metadata(parts: &[&str]) -> Option<String> {
    parts
        .iter()
        .find_map(|item| item.strip_prefix("product:"))
        .map(String::from)
}

/// Phân tích một dòng thiết bị từ adb devices -l.
fn parse_device(adb: &Path, line: &str) -> Option<AndroidDevice> {
    let mut parts = line.split_whitespace();

    let serial = parts.next()?;
    let state = parts.next()?;

    if serial == "List" || serial.starts_with('*') {
        return None;
    }

    let metadata: Vec<&str> = parts.collect();
    let product = parse_metadata(&metadata);

    // Không đọc thông tin hệ thống khi thiết bị chưa được cấp quyền.
    if state != "device" {
        return Some(AndroidDevice {
            serial: serial.to_string(),
            state: state.to_string(),
            manufacturer: None,
            model: None,
            android_version: None,
            resolution: None,
            product,
        });
    }

    let properties = get_properties(adb, serial);

    Some(AndroidDevice {
        serial: serial.to_string(),
        state: state.to_string(),
        manufacturer: properties.get("ro.product.manufacturer").cloned(),
        model: properties.get("ro.product.model").cloned(),
        android_version: properties.get("ro.build.version.release").cloned(),
        resolution: get_resolution(adb, serial),
        product,
    })
}

/// Liệt kê tất cả thiết bị ADB, bao gồm unauthorized và offline.
pub fn list_devices(adb: &Path) -> Result<Vec<AndroidDevice>, String> {
    let output = run_adb(adb, &["devices", "-l"])?;

    Ok(output
        .lines()
        .filter_map(|line| parse_device(adb, line))
        .collect())
}

/// Xác minh thiết bị đã kết nối và được cấp quyền ADB.
pub fn verify_device(adb: &Path, serial: &str) -> Result<(), String> {
    let output =
        run_command_with_timeout(adb, &["-s", serial, "get-state"], VERIFY_DEVICE_TIMEOUT)?;

    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if error.is_empty() {
            format!("Không thể xác minh thiết bị ADB: {}", output.status)
        } else {
            error
        });
    }

    let state = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if state != "device" {
        return Err(format!(
            "Thiết bị {serial} chưa sẵn sàng. Trạng thái: {state}"
        ));
    }

    Ok(())
}

/// Kiểm tra thiết bị còn kết nối và sẵn sàng sử dụng.
pub fn is_device_ready(adb: &Path, serial: &str) -> Result<bool, String> {
    let devices = list_devices(adb)?;

    Ok(devices
        .iter()
        .any(|device| device.serial == serial && device.state == "device"))
}
