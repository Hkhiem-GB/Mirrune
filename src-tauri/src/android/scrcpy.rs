use super::media_transport::MediaTransport;
use super::tools::AndroidTools;
use super::{adb::run_command_with_timeout, media::MediaReceiver};
use serde::Serialize;
use std::{
    env,
    io::Read,
    net::TcpStream,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const REMOTE_SERVER: &str = "/data/local/tmp/scrcpy-server.jar";
const SERVER_CLASS: &str = "com.genymobile.scrcpy.Server";
const ADB_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const DEVICE_NAME_LENGTH: usize = 64;
const VIDEO_SESSION_HEADER_LENGTH: usize = 12;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrcpyStreamMetadata {
    pub device_name: String,
    pub video_codec: String,
    pub audio_codec: Option<String>,
    pub video_width: u32,
    pub video_height: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrcpyMediaInfo {
    pub port: u16,
    pub token: String,
    pub metadata: ScrcpyStreamMetadata,
}

pub struct ScrcpyRuntime {
    child: Child,
    serial: String,
    forward_port: u16,
    tools: AndroidTools,
    pub(crate) media_transport: MediaTransport,
    pub metadata: ScrcpyStreamMetadata,
}

impl ScrcpyRuntime {
    pub fn start(serial: &str, tools: &AndroidTools) -> Result<Self, String> {
        let startup_started = Instant::now();
        let phase_started = Instant::now();
        let (server_path, version) = resolve_server(tools)?;
        eprintln!(
            "[Mirrune] Scrcpy server resolution: {} ms",
            phase_started.elapsed().as_millis()
        );

        let scid = generate_scid();
        let port = allocate_port()?;

        let local_endpoint = format!("tcp:{port}");
        let remote_endpoint = format!("localabstract:scrcpy_{scid}");

        adb_command(
            tools,
            serial,
            &[
                "push",
                server_path
                    .to_str()
                    .ok_or("Đường dẫn scrcpy-server không hợp lệ")?,
                REMOTE_SERVER,
            ],
        )?;
        eprintln!(
            "[Mirrune] Scrcpy server push: {} ms",
            phase_started.elapsed().as_millis()
        );

        let phase_started = Instant::now();
        adb_command(
            tools,
            serial,
            &["forward", &local_endpoint, &remote_endpoint],
        )?;
        eprintln!(
            "[Mirrune] ADB forward setup: {} ms",
            phase_started.elapsed().as_millis()
        );

        let classpath = format!("CLASSPATH={REMOTE_SERVER}");
        let scid_arg = format!("scid={scid}");

        let phase_started = Instant::now();
        let mut child = match Command::new(tools.adb())
            .args([
                "-s",
                serial,
                "shell",
                &classpath,
                "app_process",
                "/",
                SERVER_CLASS,
                &version,
                &scid_arg,
                "tunnel_forward=true",
                "video=true",
                "audio=true",
                "control=false",
                "cleanup=true",
                "max_size=1920",
                "max_fps=60",
                "video_bit_rate=12000000",
                "video_codec=h264",
                "audio_codec=opus",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()
        {
            Ok(child) => child,
            Err(error) => {
                remove_forward(tools, serial, port);

                return Err(format!("Không thể khởi chạy scrcpy Server: {error}"));
            }
        };

        let setup_result = Self::establish_streams(port, &mut child);

        let (video_socket, audio_socket, metadata) = match setup_result {
            Ok(result) => result,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                remove_forward(tools, serial, port);

                return Err(error);
            }
        };
        eprintln!(
            "[Mirrune] Scrcpy startup and stream handshake: {} ms",
            phase_started.elapsed().as_millis()
        );

        let phase_started = Instant::now();
        let media_receiver = match MediaReceiver::start(video_socket, audio_socket) {
            Ok(receiver) => receiver,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                remove_forward(tools, serial, port);

                return Err(format!("Không thể khởi tạo media receiver: {error}"));
            }
        };
        eprintln!(
            "[Mirrune] Media receiver setup: {} ms",
            phase_started.elapsed().as_millis()
        );

        let phase_started = Instant::now();
        let media_transport = match MediaTransport::start(media_receiver) {
            Ok(transport) => transport,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                remove_forward(tools, serial, port);

                return Err(format!("Không thể khởi tạo media transport: {error}"));
            }
        };
        eprintln!(
            "[Mirrune] Media transport setup: {} ms; total startup: {} ms",
            phase_started.elapsed().as_millis(),
            startup_started.elapsed().as_millis()
        );

        Ok(Self {
            child,
            serial: serial.to_string(),
            forward_port: port,
            tools: tools.clone(),
            media_transport,
            metadata,
        })
    }

    pub fn media_info(&self) -> ScrcpyMediaInfo {
        ScrcpyMediaInfo {
            port: self.media_transport.port(),
            token: self.media_transport.token().to_string(),
            metadata: self.metadata.clone(),
        }
    }

    fn establish_streams(
        port: u16,
        child: &mut Child,
    ) -> Result<(TcpStream, TcpStream, ScrcpyStreamMetadata), String> {
        fn connect_video_socket(port: u16, child: &mut Child) -> Result<TcpStream, String> {
            let address = format!("127.0.0.1:{port}");
            let started = Instant::now();

            let mut last_error = String::from("Chưa nhận được phản hồi từ scrcpy Server");

            loop {
                if let Some(status) = child
                    .try_wait()
                    .map_err(|error| format!("Không thể kiểm tra scrcpy Server: {error}"))?
                {
                    return Err(format!(
                        "scrcpy Server đã thoát khi thiết lập video: {status}"
                    ));
                }

                if started.elapsed() >= CONNECT_TIMEOUT {
                    return Err(format!(
                        "Hết thời gian chờ dummy byte từ scrcpy Server: {last_error}"
                    ));
                }

                match TcpStream::connect(&address) {
                    Ok(mut socket) => {
                        socket
                            .set_read_timeout(Some(Duration::from_millis(500)))
                            .map_err(|error| {
                                format!("Không thể đặt timeout video socket: {error}")
                            })?;

                        let mut dummy = [0u8; 1];

                        match socket.read_exact(&mut dummy) {
                            Ok(()) => {
                                if dummy[0] != 0 {
                                    return Err(format!(
                                        "Dummy byte không hợp lệ: 0x{:02X}",
                                        dummy[0]
                                    ));
                                }

                                return Ok(socket);
                            }

                            Err(error) => {
                                let retryable = matches!(
                                    error.kind(),
                                    std::io::ErrorKind::UnexpectedEof
                                        | std::io::ErrorKind::ConnectionReset
                                        | std::io::ErrorKind::ConnectionAborted
                                        | std::io::ErrorKind::NotConnected
                                );

                                if !retryable {
                                    return Err(format!("Không nhận được dummy byte: {error}"));
                                }

                                last_error = error.to_string();
                            }
                        }
                    }

                    Err(error) => {
                        last_error = error.to_string();
                    }
                }

                thread::sleep(Duration::from_millis(100));
            }
        }

        // scrcpy accepts video first, then audio.
        let mut video_socket = connect_video_socket(port, child)?;

        let mut audio_socket = connect_socket(port, child)
            .map_err(|error| format!("Không thể mở audio socket: {error}"))?;

        video_socket
            .set_nodelay(true)
            .map_err(|error| format!("Không thể cấu hình video socket: {error}"))?;

        audio_socket
            .set_nodelay(true)
            .map_err(|error| format!("Không thể cấu hình audio socket: {error}"))?;

        video_socket
            .set_read_timeout(Some(HANDSHAKE_TIMEOUT))
            .map_err(|error| format!("Không thể đặt timeout video: {error}"))?;

        audio_socket
            .set_read_timeout(Some(HANDSHAKE_TIMEOUT))
            .map_err(|error| format!("Không thể đặt timeout audio: {error}"))?;

        // Device metadata is sent only on the first socket.
        let device_name = read_device_name(&mut video_socket)?;

        // Read video codec and initial session dimensions.
        let video_codec_id = read_u32_be(&mut video_socket)?;
        let video_codec = parse_video_codec(video_codec_id)?;

        let (video_width, video_height) = read_video_session(&mut video_socket)?;

        // Audio has its own codec metadata.
        let audio_codec_id = read_u32_be(&mut audio_socket)?;
        let audio_codec = parse_audio_codec(audio_codec_id)?;

        // Handshake completed. Streaming readers will own these sockets next.
        video_socket
            .set_read_timeout(None)
            .map_err(|error| format!("Không thể bỏ timeout video: {error}"))?;

        audio_socket
            .set_read_timeout(None)
            .map_err(|error| format!("Không thể bỏ timeout audio: {error}"))?;

        let metadata = ScrcpyStreamMetadata {
            device_name,
            video_codec,
            audio_codec,
            video_width,
            video_height,
        };

        Ok((video_socket, audio_socket, metadata))
    }
}

impl Drop for ScrcpyRuntime {
    fn drop(&mut self) {
        // Stop the scrcpy server process.
        let _ = self.child.kill();
        let _ = self.child.wait();

        // Remove the ADB forwarding rule.
        remove_forward(&self.tools, &self.serial, self.forward_port);
    }
}

fn read_device_name(socket: &mut TcpStream) -> Result<String, String> {
    let mut buffer = [0u8; DEVICE_NAME_LENGTH];

    socket
        .read_exact(&mut buffer)
        .map_err(|error| format!("Không thể đọc metadata tên thiết bị: {error}"))?;

    let end = buffer
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(buffer.len());

    let name = String::from_utf8_lossy(&buffer[..end]).trim().to_string();

    if name.is_empty() {
        return Err("scrcpy trả về tên thiết bị trống.".to_string());
    }

    Ok(name)
}

fn read_u32_be(socket: &mut TcpStream) -> Result<u32, String> {
    let mut buffer = [0u8; 4];

    socket
        .read_exact(&mut buffer)
        .map_err(|error| format!("Không thể đọc codec metadata: {error}"))?;

    Ok(u32::from_be_bytes(buffer))
}

fn read_video_session(socket: &mut TcpStream) -> Result<(u32, u32), String> {
    let mut header = [0u8; VIDEO_SESSION_HEADER_LENGTH];

    socket
        .read_exact(&mut header)
        .map_err(|error| format!("Không thể đọc video session header: {error}"))?;

    if header[0] & 0x80 == 0 {
        return Err("scrcpy không gửi video session header hợp lệ.".to_string());
    }

    let width = u32::from_be_bytes([header[4], header[5], header[6], header[7]]);

    let height = u32::from_be_bytes([header[8], header[9], header[10], header[11]]);

    if width == 0 || height == 0 {
        return Err(format!("Độ phân giải video không hợp lệ: {width}x{height}"));
    }

    Ok((width, height))
}

fn parse_video_codec(codec_id: u32) -> Result<String, String> {
    match codec_id {
        0x6832_3634 => Ok("h264".to_string()),
        0x6832_3635 => Ok("h265".to_string()),
        0x0061_7631 => Ok("av1".to_string()),
        0x0076_7038 => Ok("vp8".to_string()),
        0x0076_7039 => Ok("vp9".to_string()),

        0 => Err("scrcpy đã tắt luồng video.".to_string()),

        1 => Err("Thiết bị báo lỗi cấu hình video.".to_string()),

        _ => Err(format!("Video codec không được hỗ trợ: 0x{codec_id:08x}")),
    }
}

fn parse_audio_codec(codec_id: u32) -> Result<Option<String>, String> {
    match codec_id {
        0x6f70_7573 => Ok(Some("opus".to_string())),
        0x0061_6163 => Ok(Some("aac".to_string())),
        0x666c_6163 => Ok(Some("flac".to_string())),
        0x0072_6177 => Ok(Some("raw".to_string())),

        0 => Ok(None),

        1 => Err("Thiết bị báo lỗi cấu hình audio.".to_string()),

        _ => Err(format!("Audio codec không được hỗ trợ: 0x{codec_id:08x}")),
    }
}

fn adb_command(tools: &AndroidTools, serial: &str, args: &[&str]) -> Result<String, String> {
    let mut command_args = Vec::with_capacity(args.len() + 2);
    command_args.push("-s");
    command_args.push(serial);
    command_args.extend_from_slice(args);
    let output = run_command_with_timeout(tools.adb(), &command_args, ADB_COMMAND_TIMEOUT)?;

    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();

        return Err(if error.is_empty() {
            format!("ADB thực thi thất bại: {}", output.status)
        } else {
            error
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn resolve_server(tools: &AndroidTools) -> Result<(PathBuf, String), String> {
    if let Some((server, version)) = tools.bundled_scrcpy() {
        return Ok((server.to_path_buf(), version.to_string()));
    }

    let version = env::var("MIRRUNE_SCRCPY_VERSION")
        .ok()
        .or_else(detect_scrcpy_version)
        .ok_or_else(|| {
            "Không xác định được phiên bản scrcpy. Hãy kiểm tra scrcpy trong PATH hoặc đặt MIRRUNE_SCRCPY_VERSION."
                .to_string()
        })?;

    let server_path = if let Some(path) = env::var_os("MIRRUNE_SCRCPY_SERVER") {
        PathBuf::from(path)
    } else {
        let executable = find_scrcpy_executable()
            .ok_or_else(|| {
                "Không tìm thấy scrcpy.exe trong PATH. Hãy đặt MIRRUNE_SCRCPY_SERVER trỏ tới file scrcpy-server."
                    .to_string()
            })?;

        let directory = executable
            .parent()
            .ok_or("Không xác định được thư mục scrcpy")?;

        let candidates = [
            directory.join("scrcpy-server"),
            directory.join(format!("scrcpy-server-v{version}")),
        ];

        candidates
            .into_iter()
            .find(|path| path.is_file())
            .ok_or_else(|| {
                format!(
                    "Không tìm thấy scrcpy-server phiên bản {version} cạnh scrcpy.exe. Hãy đặt MIRRUNE_SCRCPY_SERVER trỏ tới file server chính xác."
                )
            })?
    };

    if !server_path.is_file() {
        return Err(format!(
            "File scrcpy-server không tồn tại: {}",
            server_path.display()
        ));
    }

    Ok((server_path, version))
}

fn find_scrcpy_executable() -> Option<PathBuf> {
    let path = env::var_os("PATH")?;

    for directory in env::split_paths(&path) {
        let candidate = directory.join("scrcpy.exe");

        if candidate.is_file() {
            return Some(candidate);
        }
    }

    None
}

fn detect_scrcpy_version() -> Option<String> {
    let output =
        run_command_with_timeout(Path::new("scrcpy"), &["--version"], Duration::from_secs(10))
            .ok()?;

    if !output.status.success() {
        return None;
    }

    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    text.split_whitespace()
        .find(|part| {
            part.chars()
                .next()
                .is_some_and(|character| character.is_ascii_digit())
        })
        .map(String::from)
}

fn generate_scid() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();

    let value = ((nanos ^ std::process::id() as u128) & 0x7fff_ffff) as u32;

    format!("{value:08x}")
}

fn allocate_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("Không thể cấp cổng TCP: {error}"))?;

    let port = listener
        .local_addr()
        .map_err(|error| format!("Không thể đọc cổng TCP: {error}"))?
        .port();

    drop(listener);

    Ok(port)
}

fn connect_socket(port: u16, child: &mut Child) -> Result<TcpStream, String> {
    let address = format!("127.0.0.1:{port}");
    let started = Instant::now();

    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Không thể kiểm tra scrcpy Server: {error}"))?
        {
            return Err(format!(
                "scrcpy Server đã thoát trước khi mở socket: {status}"
            ));
        }

        match TcpStream::connect(&address) {
            Ok(socket) => return Ok(socket),

            Err(error) if started.elapsed() < CONNECT_TIMEOUT => {
                let _ = error;
                thread::sleep(Duration::from_millis(50));
            }

            Err(error) => {
                return Err(format!("Hết thời gian chờ kết nối {address}: {error}"));
            }
        }
    }
}

fn remove_forward(tools: &AndroidTools, serial: &str, port: u16) {
    let endpoint = format!("tcp:{port}");

    let _ = adb_command(tools, serial, &["forward", "--remove", &endpoint]);
}
