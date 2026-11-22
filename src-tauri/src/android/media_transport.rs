use super::media::{MediaEvent, MediaReceiver, MediaStream};

use std::{
    io,
    net::{TcpListener, TcpStream},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use tungstenite::{Error as WsError, Message, accept};

const HEADER_SIZE: usize = 20;

const ACCEPT_POLL_INTERVAL: Duration = Duration::from_millis(25);
const IDLE_POLL_INTERVAL: Duration = Duration::from_millis(10);
const CLIENT_POLL_INTERVAL: Duration = Duration::from_millis(100);

const AUTH_TIMEOUT: Duration = Duration::from_secs(5);
const AUTH_READ_TIMEOUT: Duration = Duration::from_millis(100);
const WRITE_TIMEOUT: Duration = Duration::from_secs(2);

const READY_MESSAGE: &str = "MIRRUNE_READY";
const BUSY_MESSAGE: &str = "MIRRUNE_BUSY";

// Generation counter incremented on every accepted client connection.
// Used by the frontend to detect reconnects and reset decoder state so
// stale config from a previous session is never mistaken for the current one.
static CLIENT_GENERATION: AtomicU64 = AtomicU64::new(0);

pub(crate) struct MediaTransport {
    port: u16,
    token: String,
    shutdown: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl MediaTransport {
    pub(crate) fn start(receiver: MediaReceiver) -> Result<Self, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|error| format!("Không thể mở media server: {error}"))?;

        listener
            .set_nonblocking(true)
            .map_err(|error| format!("Không thể cấu hình media server: {error}"))?;

        let port = listener
            .local_addr()
            .map_err(|error| format!("Không thể lấy media server port: {error}"))?
            .port();

        let token = uuid::Uuid::new_v4().simple().to_string();

        let shutdown = Arc::new(AtomicBool::new(false));

        let worker_shutdown = Arc::clone(&shutdown);
        let worker_token = token.clone();

        let worker = thread::Builder::new()
            .name("mirrune-media-transport".into())
            .spawn(move || {
                server_loop(listener, receiver, worker_token, worker_shutdown);
            })
            .map_err(|error| format!("Không thể khởi chạy media server: {error}"))?;

        Ok(Self {
            port,
            token,
            shutdown,
            worker: Some(worker),
        })
    }

    pub(crate) fn port(&self) -> u16 {
        self.port
    }

    pub(crate) fn token(&self) -> &str {
        &self.token
    }
}

impl Drop for MediaTransport {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Release);

        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

// --------------------------------------------------
// Server lifecycle
// --------------------------------------------------

fn server_loop(
    listener: TcpListener,
    mut receiver: MediaReceiver,
    token: String,
    shutdown: Arc<AtomicBool>,
) {
    while !shutdown.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, _address)) => {
                handle_client(stream, &mut receiver, &token, &shutdown);
            }

            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                // No client connected yet. Let media packets accumulate in
                // the bounded queue instead of discarding them: the first
                // client to authenticate must receive codec configuration
                // (SPS/PPS) so the decoder can be initialized. The queue is
                // bounded and preserves config/keyframe/session events, so
                // idle time does not cause unbounded growth.
                thread::sleep(ACCEPT_POLL_INTERVAL);
            }

            Err(error) => {
                eprintln!("[Mirrune] Media listener error: {error}");

                thread::sleep(Duration::from_millis(100));
            }
        }
    }
}

// --------------------------------------------------
// Client handling
// --------------------------------------------------

fn handle_client(
    stream: TcpStream,
    receiver: &mut MediaReceiver,
    expected_token: &str,
    shutdown: &AtomicBool,
) {
    let generation = CLIENT_GENERATION.fetch_add(1, Ordering::AcqRel);

    // The listener is nonblocking for accept polling. Accepted streams must be
    // switched back explicitly: WebSocket writes on a nonblocking Windows
    // socket can fail with WSAEWOULDBLOCK (10035) during normal backpressure.
    if let Err(error) = stream.set_nonblocking(false) {
        eprintln!("[Mirrune] Cannot configure blocking media socket: {error}");
        return;
    }

    if let Err(error) = stream.set_nodelay(true) {
        eprintln!("[Mirrune] Cannot configure TCP_NODELAY: {error}");
        return;
    }

    let mut socket = match accept(stream) {
        Ok(socket) => socket,

        Err(error) => {
            eprintln!("[Mirrune] WebSocket handshake failed: {error}");
            return;
        }
    };

    {
        let tcp = socket.get_mut();

        if let Err(error) = tcp.set_nonblocking(false) {
            eprintln!("[Mirrune] Cannot configure blocking WebSocket: {error}");
            return;
        }

        if let Err(error) = tcp.set_read_timeout(Some(AUTH_READ_TIMEOUT)) {
            eprintln!("[Mirrune] Cannot configure read timeout: {error}");
            return;
        }

        if let Err(error) = tcp.set_write_timeout(Some(WRITE_TIMEOUT)) {
            eprintln!("[Mirrune] Cannot configure write timeout: {error}");
            return;
        }
    }

    if !authenticate_client(&mut socket, expected_token, shutdown) {
        let _ = socket.close(None);
        return;
    }

    receiver.prepare_for_client();

    let ready = format!("{READY_MESSAGE} {generation}");

    if socket.send(Message::Text(ready)).is_err() {
        return;
    }

    {
        let tcp = socket.get_mut();

        let _ = tcp.set_read_timeout(None);
    }

    stream_media(&mut socket, receiver, generation, shutdown);

    let _ = socket.close(None);
}

// --------------------------------------------------
// Authentication
// --------------------------------------------------

fn authenticate_client(
    socket: &mut tungstenite::WebSocket<TcpStream>,
    expected_token: &str,
    shutdown: &AtomicBool,
) -> bool {
    let started = Instant::now();

    while !shutdown.load(Ordering::Acquire) {
        if started.elapsed() >= AUTH_TIMEOUT {
            eprintln!("[Mirrune] WebSocket authentication timed out.");

            return false;
        }

        match socket.read() {
            Ok(Message::Text(received)) => {
                if received == expected_token {
                    return true;
                }

                eprintln!("[Mirrune] WebSocket authentication rejected.");

                let _ = socket.send(Message::Text("MIRRUNE_AUTH_FAILED".to_string()));

                return false;
            }

            Ok(Message::Close(_)) => {
                return false;
            }

            Ok(Message::Ping(payload)) => {
                if socket.send(Message::Pong(payload)).is_err() {
                    return false;
                }
            }

            Ok(Message::Pong(_)) => {}

            Ok(Message::Binary(_)) => {
                eprintln!("[Mirrune] Binary data rejected before authentication.");

                return false;
            }

            Ok(Message::Frame(_)) => {}

            Err(WsError::Io(error))
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock
                        | io::ErrorKind::TimedOut
                        | io::ErrorKind::Interrupted
                ) =>
            {
                // Continue authentication polling without draining the media
                // queue: codec configuration packets must survive until the
                // client is authenticated and starts consuming the stream.
            }

            Err(error) => {
                eprintln!("[Mirrune] Authentication socket error: {error}");

                return false;
            }
        }

        thread::sleep(IDLE_POLL_INTERVAL);
    }

    false
}

// --------------------------------------------------
// Media streaming
// --------------------------------------------------

fn stream_media(
    socket: &mut tungstenite::WebSocket<TcpStream>,
    receiver: &mut MediaReceiver,
    generation: u64,
    shutdown: &AtomicBool,
) {
    while !shutdown.load(Ordering::Acquire) {
        match receiver.recv_timeout(CLIENT_POLL_INTERVAL) {
            Ok(event) => {
                let frame = encode_event(event, generation);

                if let Err(error) = send_media_frame(socket, frame, shutdown) {
                    if !is_expected_client_disconnect(&error) {
                        eprintln!("[Mirrune] Media WebSocket send failed: {error}");
                    }

                    break;
                }
            }

            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                // Continue checking shutdown state.
            }

            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                eprintln!("[Mirrune] Media receiver disconnected.");

                break;
            }
        }
    }
}

fn is_expected_client_disconnect(error: &WsError) -> bool {
    match error {
        WsError::ConnectionClosed | WsError::AlreadyClosed => true,
        WsError::Io(error) => matches!(
            error.kind(),
            io::ErrorKind::BrokenPipe
                | io::ErrorKind::ConnectionReset
                | io::ErrorKind::ConnectionAborted
                | io::ErrorKind::NotConnected
                | io::ErrorKind::UnexpectedEof
        ),
        _ => false,
    }
}

fn send_media_frame(
    socket: &mut tungstenite::WebSocket<TcpStream>,
    frame: Vec<u8>,
    shutdown: &AtomicBool,
) -> Result<(), WsError> {
    match socket.send(Message::Binary(frame)) {
        Ok(()) => Ok(()),
        Err(WsError::Io(error)) if error.kind() == io::ErrorKind::WouldBlock => {
            let deadline = Instant::now() + WRITE_TIMEOUT;
            while !shutdown.load(Ordering::Acquire) && Instant::now() < deadline {
                match socket.flush() {
                    Ok(()) => return Ok(()),
                    Err(WsError::Io(error))
                        if matches!(
                            error.kind(),
                            io::ErrorKind::WouldBlock
                                | io::ErrorKind::TimedOut
                                | io::ErrorKind::Interrupted
                        ) =>
                    {
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(error) => return Err(error),
                }
            }

            Err(WsError::Io(io::Error::new(
                io::ErrorKind::TimedOut,
                "media socket remained backpressured",
            )))
        }
        Err(error) => Err(error),
    }
}

// --------------------------------------------------
// MRN1 binary protocol
// --------------------------------------------------

fn encode_event(event: MediaEvent, generation: u64) -> Vec<u8> {
    let mut frame = Vec::with_capacity(HEADER_SIZE + 1024);

    frame.extend_from_slice(b"MRN1");

    let generation_low = u16::try_from(generation).unwrap_or(u16::MAX);

    let (stream_type, flags, pts, payload) = match event {
        MediaEvent::Packet { stream, packet } => {
            let stream_type = match stream {
                MediaStream::Video => 1,
                MediaStream::Audio => 2,
            };

            let mut flags = 0u8;

            if packet.is_config {
                flags |= 0x01;
            }

            if packet.is_keyframe {
                flags |= 0x02;
            }

            (
                stream_type,
                flags,
                packet.pts_us.unwrap_or(u64::MAX),
                packet.payload,
            )
        }

        MediaEvent::VideoSession {
            width,
            height,
            client_resized,
        } => {
            let mut payload = Vec::with_capacity(9);

            payload.extend_from_slice(&width.to_be_bytes());
            payload.extend_from_slice(&height.to_be_bytes());
            payload.push(u8::from(client_resized));

            (3, 0, u64::MAX, payload)
        }

        MediaEvent::Error { stream, message } => {
            let stream_type = match stream {
                MediaStream::Video => 1,
                MediaStream::Audio => 2,
            };

            (4, stream_type, u64::MAX, message.into_bytes())
        }
    };

    let payload_length = match u32::try_from(payload.len()) {
        Ok(length) => length,

        Err(_) => {
            // The receiver's packet-size limit should prevent
            // this case. Keep the encoder defensive.
            return Vec::new();
        }
    };

    frame.push(stream_type);
    frame.push(flags);

    // Reserved bytes: high byte carries the client generation so the
    // frontend can detect reconnects and reset decoder state.
    frame.extend_from_slice(&[(generation_low >> 8) as u8, generation_low as u8]);

    frame.extend_from_slice(&pts.to_be_bytes());
    frame.extend_from_slice(&payload_length.to_be_bytes());
    frame.extend_from_slice(&payload);

    frame
}
