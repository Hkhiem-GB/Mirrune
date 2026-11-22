import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useTranslation } from "react-i18next";
import DeviceScreen from "./DeviceScreen";
import { SettingsModal } from "./components/SettingsModal";
import { AboutModal } from "./components/AboutModal";
import { UpdateModal } from "./components/UpdateModal";
import {
    MEDIA_PIPELINE_LOG_EVENT,
    type MediaPipelineLogPayload,
    type MediaPipelineLogLevel,
} from "./services/mediaPipelineLog";
import {
    Activity,
    AudioLines,
    Cable,
    Check,
    CheckCircle2,
    ChevronRight,
    CircleAlert,
    MonitorSmartphone,
    PlugZap,
    Radio,
    RefreshCw,
    ScanLine,
    Settings,
    Smartphone,
    Unplug,
    Video,
    Wifi, X,
    Zap,
} from "lucide-react";
import "./App.css";

interface AndroidDevice {
    serial: string;
    state: string;
    manufacturer: string | null;
    model: string | null;
    androidVersion: string | null;
    resolution: string | null;
    product: string | null;
}

type AndroidSessionStatus =
    | "disconnected"
    | "connecting"
    | "connected"
    | "streaming"
    | "disconnecting"
    | "error";

interface AndroidSessionInfo {
    status: AndroidSessionStatus;
    serial: string | null;
    error: string | null;
}

interface PipelineLogEntry extends MediaPipelineLogPayload {
    id: number;
    time: string;
}

async function createDeviceScreenIfNeeded() {
    const existing = await WebviewWindow.getByLabel("device-screen");

    if (existing) {
        return existing;
    }

    const screenWindow = new WebviewWindow("device-screen", {
        url: "index.html#device-screen",
        title: "Mirrune — Device Screen",
        width: 1000,
        height: 720,
        minWidth: 480,
        minHeight: 360,
        center: true,
        resizable: true,
        focus: false,
        visible: false
    });

    await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => {
            reject(new Error("Tạo cửa sổ media quá thời gian chờ 10 giây."));
            void screenWindow.close().catch((error) => {
                console.error("Không thể dọn cửa sổ media khởi tạo lỗi:", error);
            });
        }, 10_000);

        screenWindow.once("tauri://created", () => {
            window.clearTimeout(timer);
            resolve();
        });

        screenWindow.once("tauri://error", (event) => {
            window.clearTimeout(timer);
            reject(event.payload);
        });
    });

    return screenWindow;
}

async function openDeviceScreen() {
    const screenWindow = await createDeviceScreenIfNeeded();
    // A hidden new viewer reveals itself after its first decoded frame.
    if (await screenWindow.isVisible()) {
        await screenWindow.setFocus();
    }
}

function MainApp() {
    const { t } = useTranslation();
    const [appVersion, setAppVersion] = useState("0.1.1");
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [isAboutOpen, setIsAboutOpen] = useState(false);
    const [isUpdateOpen, setIsUpdateOpen] = useState(false);

    useEffect(() => {
        void getVersion().then((v) => { if (v) setAppVersion(v); }).catch(() => {});
    }, []);

    const [devices, setDevices] = useState<AndroidDevice[]>([]);
    const [activeSerial, setActiveSerial] = useState<string | null>(null);
    const [sessionStatus, setSessionStatus] =
        useState<AndroidSessionStatus>("disconnected");
    const [loading, setLoading] = useState(false);
    const [connecting, setConnecting] = useState(false);

    const [error, setError] = useState("");
    const [message, setMessage] = useState("");
    const [noticeLeaving, setNoticeLeaving] = useState(false);
    const [connectingSerial, setConnectingSerial] = useState<string | null>(null);
    const [pipelineLogs, setPipelineLogs] = useState<PipelineLogEntry[]>([]);
    const pipelineLogListRef = useRef<HTMLDivElement | null>(null);
    const pipelineLogSequence = useRef(0);
    const pipelineFailureRef = useRef<string | null>(null);
    const mediaFrameReadyRef = useRef(false);
    const acceptPipelineEventsRef = useRef(true);

    const addPipelineLog = useCallback(
        (level: MediaPipelineLogLevel, logMessage: string) => {
            pipelineLogSequence.current += 1;
            const entry: PipelineLogEntry = {
                id: pipelineLogSequence.current,
                time: new Date().toLocaleTimeString("vi-VN", {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                }),
                level,
                message: logMessage,
            };
            setPipelineLogs((previous) => [...previous.slice(-99), entry]);
        },
        []
    );

    const scanDevices = useCallback(async () => {
        setLoading(true);
        setError("");

        try {
            const result = await invoke<AndroidDevice[]>(
                "list_android_devices"
            );

            setDevices(result);

            const session = await invoke<AndroidSessionInfo>("get_android_session");
            setActiveSerial(session.serial);
            setSessionStatus(session.status);
        } catch (err) {
            setError(String(err));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        let disposed = false;
        let unlisten: (() => void) | undefined;

        void listen<MediaPipelineLogPayload>(
            MEDIA_PIPELINE_LOG_EVENT,
            ({ payload }) => {
                if (!acceptPipelineEventsRef.current) {
                    return;
                }
                addPipelineLog(payload.level, payload.message);
                if (payload.ready) {
                    mediaFrameReadyRef.current = true;
                }
                if (payload.level === "error") {
                    pipelineFailureRef.current = payload.message;
                }
            }
        ).then((stopListening) => {
            if (disposed) {
                stopListening();
            } else {
                unlisten = stopListening;
            }
        }).catch((listenError) => {
            console.error("Không thể theo dõi media pipeline log:", listenError);
        });

        return () => {
            disposed = true;
            unlisten?.();
        };
    }, [addPipelineLog]);

    useEffect(() => {
        const logList = pipelineLogListRef.current;
        if (logList) {
            logList.scrollTo({
                top: logList.scrollHeight,
                behavior: "smooth",
            });
        }
    }, [pipelineLogs]);

    useEffect(() => {
        void scanDevices();

        const interval = window.setInterval(async () => {
            try {
                const active = await invoke<string | null>(
                    "refresh_android_connection"
                );

                const session = await invoke<AndroidSessionInfo>(
                    "get_android_session"
                );
                setActiveSerial(session.serial ?? active);
                setSessionStatus(session.status);

                const result = await invoke<AndroidDevice[]>(
                    "list_android_devices"
                );

                setDevices(result);
            } catch (err) {
                console.error("Connection monitoring:", err);
            }
        }, 3000);

        return () => window.clearInterval(interval);
    }, [scanDevices]);

    useEffect(() => {
        if (!error && !message) return;

        setNoticeLeaving(false);

        const dismissTimer = window.setTimeout(() => {
            setNoticeLeaving(true);
        }, 3600);

        const clearTimer = window.setTimeout(() => {
            setError("");
            setMessage("");
        }, 4000);

        return () => {
            window.clearTimeout(dismissTimer);
            window.clearTimeout(clearTimer);
        };
    }, [error, message]);

    const connectDevice = async (serial: string) => {
        setConnecting(true);
        setConnectingSerial(serial);
        pipelineFailureRef.current = null;
        mediaFrameReadyRef.current = false;
        acceptPipelineEventsRef.current = true;
        setError("");
        setMessage("");
        const deviceName = devices.find((device) => device.serial === serial)?.model || serial;
        addPipelineLog("info", `Bắt đầu kết nối thiết bị ${deviceName}.`);

        let backendStarted = false;
        let startupStage = "đang tạo cửa sổ viewer";
        let startupProgressTimer: number | undefined;
        try {
            const startupStartedAt = Date.now();
            startupProgressTimer = window.setInterval(() => {
                const elapsedSeconds = Math.floor(
                    (Date.now() - startupStartedAt) / 1000
                );
                addPipelineLog(
                    "info",
                    `Khởi tạo video: ${startupStage} (${elapsedSeconds}s).`
                );
            }, 5000);

            addPipelineLog("info", "Khởi tạo cửa sổ media ở chế độ chờ frame đầu.");
            await createDeviceScreenIfNeeded();

            startupStage = "ADB/scrcpy/media endpoint";
            addPipelineLog("info", "Đang thiết lập ADB, scrcpy và media transport.");
            const result = await invoke<string>(
                "connect_android_device",
                { serial }
            );
            if (startupProgressTimer !== undefined) {
                window.clearInterval(startupProgressTimer);
            }
            startupProgressTimer = undefined;
            backendStarted = true;

            setActiveSerial(result);
            setSessionStatus("connected");
            startupStage = "chờ decoder render frame video đầu";
            setMessage("Đang xử lý media; vui lòng chờ frame video đầu tiên.");
            addPipelineLog("info", "Nguồn media đã sẵn sàng; đang đợi decoder render frame đầu.");

            const deadline = Date.now() + 20_000;
            while (Date.now() < deadline) {
                if (pipelineFailureRef.current) {
                    throw new Error(pipelineFailureRef.current);
                }

                const session = await invoke<AndroidSessionInfo>("get_android_session");
                setSessionStatus(session.status);
                setActiveSerial(session.serial ?? result);

                if (
                    mediaFrameReadyRef.current &&
                    session.status === "streaming" &&
                    session.serial === serial
                ) {
                    setMessage("Media đã sẵn sàng. Thiết bị đã kết nối.");
                    addPipelineLog("success", "Kết nối hoàn tất; video frame đầu đã render.");
                    return;
                }

                if (session.status === "error" || session.status === "disconnected") {
                    throw new Error(session.error || "Phiên media đã dừng trước khi video sẵn sàng.");
                }

                await new Promise<void>((resolve) =>
                    window.setTimeout(resolve, 100)
                );
            }

            throw new Error("Hết thời gian chờ video frame đầu tiên.");
        } catch (err) {
            const errorMessage = String(err);
            setError(errorMessage);
            setMessage("");
            addPipelineLog("error", `Kết nối thất bại: ${errorMessage}`);

            if (backendStarted) {
                try {
                    await invoke("disconnect_android_device");
                    setActiveSerial(null);
                    setSessionStatus("disconnected");
                } catch (disconnectError) {
                    addPipelineLog(
                        "error",
                        `Không thể dọn phiên media lỗi: ${String(disconnectError)}`
                    );
                }
            }

            try {
                const screenWindow = await WebviewWindow.getByLabel("device-screen");
                if (screenWindow && !(await screenWindow.isVisible())) {
                    await screenWindow.close();
                }
            } catch (closeError) {
                console.error("Không thể đóng cửa sổ media chưa sẵn sàng:", closeError);
            }
        } finally {
            if (startupProgressTimer !== undefined) {
                window.clearInterval(startupProgressTimer);
            }
            setConnecting(false);
            setConnectingSerial(null);
        }
    };

    const disconnectDevice = async () => {
        setConnecting(true);
        setError("");
        setMessage("");
        addPipelineLog("info", "Đang đóng phiên ADB và dừng media transport.");

        try {
            await invoke("disconnect_android_device");
            setActiveSerial(null);
            setSessionStatus("disconnected");
            setMessage("Đã ngắt phiên kết nối.");
            acceptPipelineEventsRef.current = false;
            setPipelineLogs([]);
        } catch (err) {
            setError(String(err));
            addPipelineLog("error", `Ngắt kết nối thất bại: ${String(err)}`);
        } finally {
            setConnecting(false);
        }
    };

    const activeDevice = devices.find(
        (device) => device.serial === activeSerial
    );
    const connectionLabel = connecting
        ? t("header.processing")
        : sessionStatus === "streaming"
            ? t("header.online")
            : sessionStatus === "error"
                ? "ERROR"
                : activeDevice
                    ? t("header.media_setup")
                    : t("header.idle");

    const getStatus = (state: string) => {
        if (state === "device") return t("devices.ready");
        if (state === "unauthorized") return t("devices.unauthorized");
        if (state === "offline") return t("devices.offline");
        return state;
    };

    return (
        <div className="app-shell">
            <div className="ambient ambient-red" />
            <div className="ambient ambient-violet" />
            <div className="background-grid" />

            <header className="app-header">
                <div className="brand">
                    <img
                        className="brand-logo"
                        src="/logo/svg/primary-logo-transparent.svg"
                        alt={t("header.brand_alt")}
                    />
                </div>

                <div className="header-center">
                    <span className="header-path">{t("header.workspace")}</span>
                    <ChevronRight size={13} />
                    <span className="header-current">{t("header.android_link")}</span>
                </div>

                <div className="header-status">
                    <span className="system-pulse" />
                    <span>{activeDevice ? t("header.device_linked") : t("header.system_ready")}</span>
                    <button
                        className="header-settings-btn"
                        onClick={() => setIsSettingsOpen(true)}
                        aria-label={t("header.settings_btn")}
                        title={t("header.settings_btn")}
                    >
                        <Settings size={14} />
                    </button>
                </div>

                {(error || message) && (
                    <div
                        className={`toast-notification ${
                            error ? "toast-error" : "toast-success"
                        } ${noticeLeaving ? "toast-leaving" : ""}`}
                        role="status"
                    >
                        <div className="toast-icon">
                            {error ? (
                                <CircleAlert size={18} />
                            ) : (
                                <CheckCircle2 size={18} />
                            )}
                        </div>

                        <span className="toast-message">{error || message}</span>

                        <button
                            className="toast-close"
                            aria-label="Đóng thông báo"
                            onClick={() => {
                                setNoticeLeaving(true);

                                window.setTimeout(() => {
                                    setError("");
                                    setMessage("");
                                    setNoticeLeaving(false);
                                }, 300);
                            }}
                        >
                            <X size={15} />
                        </button>
                    </div>
                )}
            </header>

            <main className="main-content">
                <section className="page-intro">
                    <div className="intro-copy">
                        <div className="eyebrow">
                            <span className="eyebrow-line" />
                            DEVICE INTERFACE / 01
                        </div>

                        <h1>
                            Device <span>Link</span>
                        </h1>

                        <p>
                            {t("intro.subtitle")}
                        </p>
                    </div>

                    <button
                        className="scan-button"
                        onClick={scanDevices}
                        disabled={loading || connecting}
                    >
                        <RefreshCw
                            size={16}
                            className={loading ? "spin" : ""}
                        />
                        <span>{loading ? t("devices.scanning") : t("devices.scan")}</span>
                        <ScanLine size={15} className="scan-decoration" />
                    </button>
                </section>

                <section className="connection-workspace">
                    <section className="surface device-surface">
                        <div className="surface-heading">
                            <div className="surface-title-group">
                                <div className="section-icon">
                                    <Smartphone size={17} />
                                </div>

                                <div>
                                    <h2>{t("devices.title")}</h2>
                                    <p>{t("intro.subtitle")}</p>
                                </div>
                            </div>

                            <div className="device-count">
                                <span>{String(devices.length).padStart(2, "0")}</span>
                                <span>DETECTED</span>
                            </div>
                        </div>

                        <div className="device-list">
                            {devices.length === 0 ? (
                                <div className="empty-state">
                                    <div className="empty-graphic">
                                        <div className="empty-orbit orbit-one" />
                                        <div className="empty-orbit orbit-two" />
                                        <div className="empty-device">
                                            <Smartphone size={29} />
                                        </div>
                                        <span className="empty-spark spark-one" />
                                        <span className="empty-spark spark-two" />
                                    </div>

                                    <h3>{t("devices.none_found")}</h3>

                                    <button
                                        className="secondary-button"
                                        onClick={scanDevices}
                                        disabled={loading}
                                    >
                                        <RefreshCw size={14} />
                                        {t("devices.scan")}
                                    </button>
                                </div>
                            ) : (
                                devices.map((device, index) => {
                                    const isActive = activeSerial === device.serial;
                                    const isReady = device.state === "device";
                                    const isConnectingThis =
                                        connectingSerial === device.serial;
                                    const isStreamReady =
                                        isActive && sessionStatus === "streaming";

                                    return (
                                        <article
                                            className={`device-card ${isActive ? "selected" : ""}`}
                                            key={device.serial}
                                            style={{ animationDelay: `${index * 60}ms` }}
                                        >
                                            <div className="device-card-accent" />

                                            <div className="device-card-main">
                                                <div className="device-icon">
                                                    <Smartphone size={23} />
                                                    <span />
                                                </div>

                                                <div className="device-identity">
                                                    <h3>{device.model || "Android Device"}</h3>
                                                    <p>
                                                        {device.manufacturer || "Unknown manufacturer"}
                                                        <span className="identity-separator">/</span>
                                                        Android {device.androidVersion || "—"}
                                                    </p>
                                                </div>

                                                <div className={`device-status ${isReady ? "ready" : "warning"}`}>
                                                    <span className="status-dot" />
                                                    {getStatus(device.state)}
                                                </div>
                                            </div>

                                            <div className="device-specs">
                                                <div className="spec-item">
                                                    <span className="spec-label">RESOLUTION</span>
                                                    <strong>{device.resolution || "—"}</strong>
                                                </div>

                                                <div className="spec-item">
                                                    <span className="spec-label">CONNECTION</span>
                                                    <strong>
                                                        <Cable size={13} />
                                                        USB
                                                    </strong>
                                                </div>

                                                <div className="spec-item">
                                                    <span className="spec-label">PRODUCT</span>
                                                    <strong>{device.product || "—"}</strong>
                                                </div>
                                            </div>

                                            <div className="device-card-bottom">
                                                <span className="device-serial">
                                                    ID <span>{device.serial}</span>
                                                </span>

                                                <button
                                                    className={
                                                        isStreamReady
                                                            ? "connected-button"
                                                            : `connect-button ${
                                                                isConnectingThis ||
                                                                (isActive && sessionStatus !== "error")
                                                                    ? "is-connecting"
                                                                    : ""
                                                            }`
                                                    }
                                                    disabled={
                                                        !isReady ||
                                                        connecting ||
                                                        (activeSerial !== null && !isActive) ||
                                                        isStreamReady
                                                    }
                                                    onClick={() => connectDevice(device.serial)}
                                                >
                                                    {isConnectingThis ? (
                                                        <>
                                                            <RefreshCw size={15} className="connect-spinner" />
                                                            {t("devices.connecting")}
                                                        </>
                                                    ) : isStreamReady ? (
                                                        <>
                                                            <Check size={15} />
                                                            {t("devices.connected")}
                                                        </>
                                                    ) : isActive ? (
                                                        <>
                                                            <RefreshCw size={15} className="connect-spinner" />
                                                            {t("devices.connecting")}
                                                        </>
                                                    ) : (
                                                        <>
                                                            <PlugZap size={15} />
                                                            {t("devices.connect")}
                                                        </>
                                                    )}
                                                </button>
                                            </div>
                                        </article>
                                    );
                                })
                            )}
                        </div>

                        <div className="surface-bottom">
                            <div className="surface-bottom-indicator">
                                <Activity size={13} />
                                <span>USB DEVICE SCANNER</span>
                            </div>

                            <span className="surface-bottom-note">
                                AUTO DETECTION ENABLED
                            </span>
                        </div>
                    </section>

                    <aside className="surface session-surface">
                        <div className="surface-heading">
                            <div className="surface-title-group">
                                <div className="section-icon section-icon-violet">
                                    <Radio size={17} />
                                </div>

                                <div>
                                    <h2>Live connection</h2>
                                    <p>Trạng thái phiên hiện tại</p>
                                </div>
                            </div>

                            <div className={`session-indicator ${sessionStatus === "streaming" ? "online" : connecting ? "processing" : sessionStatus === "error" ? "failed" : ""}`}>
                                <span />
                                {connectionLabel}
                            </div>
                        </div>

                        {activeDevice ? (
                            <div className="session-content">
                                <div className="session-device-visual">
                                    <div className="visual-ring ring-outer" />
                                    <div className="visual-ring ring-middle" />
                                    <div className="visual-core">
                                        <Smartphone size={31} />
                                    </div>
                                    <span className="visual-node node-one" />
                                    <span className="visual-node node-two" />
                                    <span className="visual-node node-three" />
                                </div>

                                <div className="session-device-name">
                                    <span className="session-overline">ACTIVE USB SESSION</span>
                                    <h3>{activeDevice.model || "Android Device"}</h3>
                                    <p>{activeDevice.manufacturer || "Unknown manufacturer"}</p>
                                </div>

                                <div className="session-specs">
                                    <div>
                                        <span>PROTOCOL</span>
                                        <strong>ADB</strong>
                                    </div>
                                    <div>
                                        <span>TRANSPORT</span>
                                        <strong><Cable size={13} /> USB</strong>
                                    </div>
                                    <div>
                                        <span>ANDROID</span>
                                        <strong>{activeDevice.androidVersion || "—"}</strong>
                                    </div>
                                    <div>
                                        <span>RESOLUTION</span>
                                        <strong>{activeDevice.resolution || "—"}</strong>
                                    </div>
                                </div>

                                <div className="pipeline">
                                    <div className="pipeline-heading">
                                        <span>MEDIA PIPELINE</span>
                                        <span className="pipeline-state">
                                            {sessionStatus === "streaming"
                                                ? "READY"
                                                : connecting || sessionStatus === "connected"
                                                    ? "PROCESSING"
                                                    : "STANDBY"}
                                        </span>
                                    </div>

                                    <div className="pipeline-item">
                                        <div className="pipeline-icon video-icon">
                                            <Video size={15} />
                                        </div>
                                        <span>Video stream</span>
                                        <span className="pipeline-waiting">
                                            {sessionStatus === "streaming"
                                                ? "Live"
                                                : connecting || sessionStatus === "connected"
                                                    ? "Processing"
                                                    : "Waiting"}
                                        </span>
                                    </div>

                                    <div className="pipeline-item">
                                        <div className="pipeline-icon audio-icon">
                                            <AudioLines size={15} />
                                        </div>
                                        <span>Audio stream</span>
                                        <span className="pipeline-waiting">
                                            {sessionStatus === "streaming" ? "Live" : "Waiting"}
                                        </span>
                                    </div>
                                </div>

                                <button
                                    className="open-screen-button"
                                    onClick={openDeviceScreen}
                                    disabled={connecting}
                                >
                                    <MonitorSmartphone size={15} />
                                    {t("devices.view_stream")}
                                </button>

                                <button
                                    className="disconnect-button"
                                    disabled={connecting}
                                    onClick={disconnectDevice}
                                >
                                    <Unplug size={15} />
                                    {connecting ? t("devices.disconnecting") : t("devices.disconnect")}
                                </button>
                            </div>
                        ) : (
                            <div className="session-empty">
                                <div className="session-empty-visual">
                                    <div className="empty-connection-ring" />
                                    <div className="empty-connection-icon">
                                        <Wifi size={28} />
                                    </div>
                                    <span className="empty-connection-node" />
                                </div>

                                <h3>Awaiting connection</h3>
                                <p>
                                    Chọn một thiết bị Android trong danh sách
                                    để thiết lập phiên kết nối USB.
                                </p>

                                <div className="waiting-label">
                                    <span />
                                    WAITING FOR DEVICE
                                </div>
                            </div>
                        )}

                        <div className="session-footer">
                            <div>
                                <Zap size={13} />
                                <span>CONNECTION MONITOR</span>
                            </div>
                            <span className="monitor-active">
                                {activeDevice ? "ACTIVE" : "STANDBY"}
                            </span>
                        </div>
                    </aside>

                    <aside className="surface log-surface" aria-label="Media processing log">
                        <div className="surface-heading">
                            <div className="surface-title-group">
                                <div className="section-icon section-icon-violet">
                                    <Activity size={17} />
                                </div>
                                <div>
                                    <h2>Media processing log</h2>
                                    <p>Tiến trình và kết quả xử lý</p>
                                </div>
                            </div>

                            <span className={`log-status ${sessionStatus === "streaming" ? "success" : sessionStatus === "error" ? "error" : connecting ? "busy" : ""}`}>
                                <span />
                                {connectionLabel}
                            </span>
                        </div>

                        <div
                            className="pipeline-log-list"
                            ref={pipelineLogListRef}
                            aria-live="polite"
                        >
                            {pipelineLogs.length === 0 ? (
                                <div className="pipeline-log-empty">
                                    <Activity size={18} />
                                    <span>Chưa có sự kiện media.</span>
                                    <small>Nhấn “Kết nối thiết bị” để bắt đầu.</small>
                                </div>
                            ) : (
                                pipelineLogs.map((entry) => (
                                    <div
                                        className={`pipeline-log-entry ${entry.level}`}
                                        key={entry.id}
                                    >
                                        <time>{entry.time}</time>
                                        <span className="pipeline-log-dot" />
                                        <p>{entry.message}</p>
                                    </div>
                                ))
                            )}
                        </div>

                        <div className="log-footer">
                            <span>PIPELINE EVENTS</span>
                            <span>{String(pipelineLogs.length).padStart(2, "0")} / 100</span>
                        </div>
                    </aside>
                </section>

                <footer className="app-footer">
                    <div>
                        <span className="footer-brand-dot" />
                        <span>{t("footer.desktop")}</span>
                    </div>

                    <span>{t("footer.tagline")}</span>
                    <span className="footer-version">{t("footer.build", { version: appVersion })}</span>
                </footer>
            </main>

            <SettingsModal
                isOpen={isSettingsOpen}
                onClose={() => setIsSettingsOpen(false)}
                onOpenAbout={() => setIsAboutOpen(true)}
                onCheckUpdate={() => setIsUpdateOpen(true)}
            />

            <AboutModal
                isOpen={isAboutOpen}
                onClose={() => setIsAboutOpen(false)}
            />

            <UpdateModal
                isOpen={isUpdateOpen}
                onClose={() => setIsUpdateOpen(false)}
            />
        </div>
    );
}

function App() {
    if (window.location.hash === "#device-screen") {
        return <DeviceScreen />;
    }

    return <MainApp />;
}
export default App;

