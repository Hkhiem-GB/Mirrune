import {
    Activity,
    AudioLines,
    Maximize2,
    Minimize2,
    MonitorSmartphone,
    RefreshCw,
    Volume2,
} from "lucide-react";

import "./DeviceScreen.css";

import {
    currentMonitor,
    getCurrentWindow,
} from "@tauri-apps/api/window";
import {
    LogicalPosition,
    LogicalSize,
    type PhysicalPosition,
    type PhysicalSize,
} from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import { reportMediaPipelineLog } from "./services/mediaPipelineLog";
import {
    useCallback,
    useEffect,
    useRef,
    useState,
} from "react";

interface ScrcpyStreamMetadata {
    deviceName: string;
    videoCodec: string;
    audioCodec: string | null;
    videoWidth: number;
    videoHeight: number;
}

interface ScrcpyMediaInfo {
    port: number;
    token: string;
    metadata: ScrcpyStreamMetadata;
}

interface MediaStats {
    videoPackets: number;
    audioPackets: number;
    totalBytes: number;
    videoBytes: number;
    audioBytes: number;
    decodedFrames: number;
}

type MediaStatus =
    | "initializing"
    | "connecting"
    | "authenticating"
    | "ready"
    | "receiving"
    | "disconnected"
    | "error";

interface AvcConfiguration {
    codec: string;
    description: ArrayBuffer;
}

interface PendingVideoPacket {
    data: Uint8Array;
    timestamp: number;
    keyframe: boolean;
}

interface VideoFrameSize {
    width: number;
    height: number;
}

const INITIAL_STATS: MediaStats = {
    videoPackets: 0,
    audioPackets: 0,
    totalBytes: 0,
    videoBytes: 0,
    audioBytes: 0,
    decodedFrames: 0,
};

const RECONNECT_DELAY = 1500;
const STATS_INTERVAL = 500;
const VIDEO_STARTUP_TIMEOUT = 15_000;

const MAX_VIDEO_PACKET_SIZE = 16 * 1024 * 1024;

// Giới hạn bộ nhớ dành riêng cho packet đang chờ decoder.
const MAX_PENDING_VIDEO_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_VIDEO_PACKETS = 12;

// Không cho decoder tích lũy quá nhiều frame chưa xử lý.
const MAX_DECODER_QUEUE = 2;

function formatBytes(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }

    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }

    if (bytes < 1024 * 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }

    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ==================================================
// H.264 NAL parser
// ==================================================

interface StartCode {
    index: number;
    length: number;
}

function findStartCode(
    data: Uint8Array,
    offset: number
): StartCode | null {
    for (let i = offset; i <= data.length - 3; i += 1) {
        // Test the four-byte prefix first. A 00 00 00 01 prefix also
        // begins with 00 00 01; matching the shorter form first shifts
        // the NAL start by one byte and makes SPS/PPS/IDR undetectable.
        if (
            i <= data.length - 4 &&
            data[i] === 0 &&
            data[i + 1] === 0 &&
            data[i + 2] === 0 &&
            data[i + 3] === 1
        ) {
            return {
                index: i,
                length: 4,
            };
        }

        if (
            data[i] === 0 &&
            data[i + 1] === 0 &&
            data[i + 2] === 1
        ) {
            return {
                index: i,
                length: 3,
            };
        }
    }

    return null;
}

function splitAnnexB(data: Uint8Array): Uint8Array[] {
    const units: Uint8Array[] = [];

    const first = findStartCode(data, 0);

    if (!first) {
        if (data.length > 0) {
            units.push(data);
        }

        return units;
    }

    let current: StartCode | null = first;

    while (current) {
        const start = current.index + current.length;
        const next = findStartCode(data, start);

        const end = next ? next.index : data.length;

        if (end > start) {
            units.push(data.subarray(start, end));
        }

        current = next;
    }

    return units;
}

function getNalType(unit: Uint8Array): number {
    if (unit.length === 0) {
        return 0;
    }

    return unit[0] & 0x1f;
}

function hasNalType(
    units: Uint8Array[],
    type: number
): boolean {
    return units.some((unit) => getNalType(unit) === type);
}

function isKeyframePacket(units: Uint8Array[]): boolean {
    // NAL type 5 = IDR picture.
    return hasNalType(units, 5);
}

// ==================================================
// AVC configuration
// ==================================================

function createAvcConfiguration(
    spsList: Uint8Array[],
    ppsList: Uint8Array[]
): AvcConfiguration {
    if (spsList.length === 0 || ppsList.length === 0) {
        throw new Error("Thiếu SPS hoặc PPS trong H.264 configuration.");
    }

    if (spsList.length > 31 || ppsList.length > 255) {
        throw new Error("Số lượng SPS/PPS không hợp lệ.");
    }

    const sps = spsList[0];

    if (sps.length < 4) {
        throw new Error("SPS H.264 không hợp lệ.");
    }

    let totalSize = 7;

    for (const item of [...spsList, ...ppsList]) {
        if (item.length === 0 || item.length > 65535) {
            throw new Error("Kích thước SPS/PPS không hợp lệ.");
        }

        totalSize += 2 + item.length;
    }

    const avcC = new Uint8Array(totalSize);

    let offset = 0;

    avcC[offset++] = 1;
    avcC[offset++] = sps[1];
    avcC[offset++] = sps[2];
    avcC[offset++] = sps[3];

    // Four-byte NAL length.
    avcC[offset++] = 0xff;

    // SPS count.
    avcC[offset++] = 0xe0 | spsList.length;

    for (const item of spsList) {
        avcC[offset++] = (item.length >> 8) & 0xff;
        avcC[offset++] = item.length & 0xff;

        avcC.set(item, offset);
        offset += item.length;
    }

    // PPS count.
    avcC[offset++] = ppsList.length;

    for (const item of ppsList) {
        avcC[offset++] = (item.length >> 8) & 0xff;
        avcC[offset++] = item.length & 0xff;

        avcC.set(item, offset);
        offset += item.length;
    }

    const description = new ArrayBuffer(avcC.length);

    new Uint8Array(description).set(avcC);

    const codec = `avc1.${sps[1]
        .toString(16)
        .padStart(2, "0")}${sps[2]
        .toString(16)
        .padStart(2, "0")}${sps[3]
        .toString(16)
        .padStart(2, "0")}`;

    return {
        codec,
        description,
    };
}

function sameConfiguration(
    first: AvcConfiguration | null,
    second: AvcConfiguration
): boolean {
    if (!first || first.codec !== second.codec) {
        return false;
    }

    const a = new Uint8Array(first.description);
    const b = new Uint8Array(second.description);

    if (a.length !== b.length) {
        return false;
    }

    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) {
            return false;
        }
    }

    return true;
}

// ==================================================
// Annex B -> AVCC
// ==================================================

function convertAnnexBToAvcc(
    data: Uint8Array
): Uint8Array {
    const units = splitAnnexB(data);

    // SPS/PPS đã được đưa vào AVCDecoderConfigurationRecord.
    // Không đưa lại parameter sets vào encoded sample.
    const videoUnits = units.filter((unit) => {
        const type = getNalType(unit);

        return type !== 7 && type !== 8;
    });

    if (videoUnits.length === 0) {
        throw new Error("Packet không chứa H.264 video NAL.");
    }

    let totalSize = 0;

    for (const unit of videoUnits) {
        totalSize += 4 + unit.length;
    }

    if (totalSize > MAX_VIDEO_PACKET_SIZE) {
        throw new Error("H.264 packet vượt quá kích thước cho phép.");
    }

    const result = new Uint8Array(totalSize);

    let offset = 0;

    for (const unit of videoUnits) {
        const length = unit.length;

        result[offset++] = (length >>> 24) & 0xff;
        result[offset++] = (length >>> 16) & 0xff;
        result[offset++] = (length >>> 8) & 0xff;
        result[offset++] = length & 0xff;

        result.set(unit, offset);

        offset += length;
    }

    return result;
}

// ==================================================
// Main component
// ==================================================

function DeviceScreen() {
    const screenWindow = getCurrentWindow();

    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const originalWindowBoundsRef = useRef<{
        size: PhysicalSize;
        position: PhysicalPosition;
    } | null>(null);
    const fullscreenTransitionRef = useRef(false);
    const fullscreenAspectRatioRef = useRef<number | null>(null);

    const [isVideoFullscreen, setIsVideoFullscreen] = useState(false);
    const [videoFrameSize, setVideoFrameSize] =
        useState<VideoFrameSize | null>(null);

    const [mediaStatus, setMediaStatus] =
        useState<MediaStatus>("initializing");

    const [mediaInfo, setMediaInfo] =
        useState<ScrcpyMediaInfo | null>(null);

    const [mediaError, setMediaError] = useState("");

    const [mediaStats, setMediaStats] =
        useState<MediaStats>(INITIAL_STATS);

    const [hasVideoFrame, setHasVideoFrame] = useState(false);

    const [decoderLabel, setDecoderLabel] =
        useState("INITIALIZING");

    const [reconnectKey, setReconnectKey] = useState(0);

    const [audioOutputEnabled, setAudioOutputEnabled] = useState(false);
    const [audioDecoderReady, setAudioDecoderReady] = useState(false);
    const [audioHasOutput, setAudioHasOutput] = useState(false);
    const [audioOutputError, setAudioOutputError] = useState("");
    const [hasShownWindow, setHasShownWindow] = useState(false);
    const activateAudioRef = useRef<(() => Promise<void>) | null>(null);

    const isMediaReady =
        mediaStatus === "ready" ||
        mediaStatus === "receiving";

    // ==================================================
    // Media transport + decoder
    // ==================================================

    useEffect(() => {
        let disposed = false;
        let waitingForSessionLogged = false;
        let hasVideoConfiguration = false;
        let hasVideoKeyframeSubmitted = false;
        let lastVideoProgressLogAt = 0;

        let socket: WebSocket | null = null;

        let retryTimer: number | undefined;
        let statsTimer: number | undefined;

        let authenticated = false;

        let decoder: VideoDecoder | null = null;

        let audioContext: AudioContext | null = null;
        let audioWorkletNode: AudioWorkletNode | null = null;
        let audioDecoder: AudioDecoder | null = null;
        let audioDecoderConfig: AudioDecoderConfig | null = null;
        let audioWorkletLoaded = false;
        let audioConfiguring = false;
        let audioFailed = false;
        let audioChannels = 2;
        let audioOutputActive = false;
        let audioHasProducedOutput = false;
        let pendingAudioPackets: Array<{ data: Uint8Array; timestamp: number }> = [];
        let drainingAudioPackets = false;

        const MAX_PENDING_AUDIO_PACKETS = 3;
        const MAX_AUDIO_DECODER_QUEUE = 2;

        let decoderConfig: VideoDecoderConfig | null = null;

        let activeAvcConfiguration: AvcConfiguration | null = null;

        let configuringDecoder = false;
        let decoderFailed = false;

        let waitingForKeyframe = true;

        let drainingPending = false;

        let pendingVideoPackets: PendingVideoPacket[] = [];
        let pendingVideoBytes = 0;

        let spsUnits: Uint8Array[] = [];
        let ppsUnits: Uint8Array[] = [];

        // Generation of the current media session, echoed by the backend in
        // every MRN1 frame (header bytes 6-7, big-endian u16). Used to detect
        // reconnects and discard stale config packets from a previous session.
        let currentGeneration: number | null = null;
        reportMediaPipelineLog({
            level: "info",
            message: "Media viewer khởi tạo; chờ backend sẵn sàng.",
        });

        let canvasContext: CanvasRenderingContext2D | null = null;
        let latestVideoFrame: VideoFrame | null = null;
        let videoFrameRaf: number | undefined;

        const counters: MediaStats = {
            ...INITIAL_STATS,
        };
        let connectionStartedAt = performance.now();
        let firstFrameRendered = false;
        let lastLoggedVideoPackets = 0;
        let lastLoggedVideoBytes = 0;
        let lastLoggedDecodedFrames = 0;

        // --------------------------------------------------
        // Opus audio output
        // --------------------------------------------------

        const clearPendingAudioPackets = () => {
            pendingAudioPackets = [];
        };

        const closeAudioDecoder = () => {
            if (audioDecoder) {
                try {
                    audioDecoder.close();
                } catch {
                    // Decoder may already be closed.
                }
                audioDecoder = null;
            }

            audioDecoderConfig = null;
            audioConfiguring = false;
            audioFailed = false;
            drainingAudioPackets = false;
            clearPendingAudioPackets();
            audioWorkletNode?.port.postMessage({ type: "flush" });

            if (!disposed) {
                setAudioDecoderReady(false);
                setAudioHasOutput(false);
            }
        };

        const parseOpusConfig = (payload: Uint8Array): number => {
            const magic = [0x41, 0x4f, 0x50, 0x55, 0x53, 0x48, 0x44, 0x52]; // AOPUSHDR

            if (payload.byteLength < 16) {
                throw new Error("Opus config packet quá ngắn.");
            }

            for (let i = 0; i < magic.length; i += 1) {
                if (payload[i] !== magic[i]) {
                    throw new Error("Không tìm thấy AOPUSHDR trong Opus config.");
                }
            }

            // scrcpy 5.0.1 ghi kích thước CSD theo native byte order của Android.
            const view = new DataView(
                payload.buffer,
                payload.byteOffset,
                payload.byteLength
            );

            const headerLength = Number(view.getBigUint64(8, true));

            if (
                !Number.isSafeInteger(headerLength) ||
                headerLength < 19 ||
                headerLength > payload.byteLength - 16
            ) {
                throw new Error("Kích thước OpusHead không hợp lệ.");
            }

            const opusHead = payload.subarray(16, 16 + headerLength);
            const opusHeadMagic = [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]; // OpusHead

            for (let i = 0; i < opusHeadMagic.length; i += 1) {
                if (opusHead[i] !== opusHeadMagic[i]) {
                    throw new Error("Opus config không chứa OpusHead hợp lệ.");
                }
            }

            const channels = opusHead[9];

            if (channels < 1 || channels > 2) {
                throw new Error(`Số kênh Opus không được hỗ trợ: ${channels}`);
            }

            return channels;
        };

        const ensureAudioOutput = async () => {
            if (disposed) {
                throw new Error("Audio output đã bị đóng.");
            }

            if (audioFailed) {
                closeAudioDecoder();
            }

            if (!audioContext) {
                const AudioContextConstructor =
                    window.AudioContext ||
                    (window as typeof window & {
                        webkitAudioContext?: typeof AudioContext;
                    }).webkitAudioContext;

                if (!AudioContextConstructor) {
                    throw new Error("Web Audio API không được hỗ trợ.");
                }

                audioContext = new AudioContextConstructor({
                    sampleRate: 48000,
                    latencyHint: "interactive",
                });
            }

            const currentAudioContext = audioContext;
            const resumePromise = currentAudioContext.resume();

            if (!currentAudioContext.audioWorklet) {
                await currentAudioContext.close();
                audioContext = null;
                throw new Error("AudioWorklet không được hỗ trợ trên WebView2.");
            }

            if (!audioWorkletLoaded) {
                try {
                    await currentAudioContext.audioWorklet.addModule(
                        new URL("./audio/opus-playback-processor.js", import.meta.url)
                    );
                    audioWorkletLoaded = true;
                } catch (error) {
                    await currentAudioContext.close();
                    if (audioContext === currentAudioContext) {
                        audioContext = null;
                    }
                    throw error;
                }
            }

            if (disposed || audioContext !== currentAudioContext) {
                throw new Error("Audio output đã bị đóng.");
            }

            await resumePromise;

            if (currentAudioContext.state !== "running") {
                throw new Error("Không thể kích hoạt AudioContext.");
            }

            if (currentAudioContext.sampleRate !== 48000) {
                throw new Error(
                    `AudioContext phải chạy ở 48000 Hz, hiện tại là ${currentAudioContext.sampleRate} Hz.`
                );
            }

            if (!audioWorkletNode) {
                audioWorkletNode = new AudioWorkletNode(
                    currentAudioContext,
                    "mirrune-opus-playback",
                    {
                        numberOfInputs: 0,
                        numberOfOutputs: 1,
                        outputChannelCount: [2],
                    }
                );

                audioWorkletNode.connect(currentAudioContext.destination);
            }

            audioOutputActive = true;
            setAudioOutputEnabled(true);
            setAudioOutputError("");

            if (audioChannels > 0) {
                await configureAudioDecoder(audioChannels);
            }
        };
        activateAudioRef.current = ensureAudioOutput;

        const renderAudioData = (audioData: AudioData) => {
            try {
                if (
                    disposed ||
                    !audioWorkletNode ||
                    !audioContext ||
                    audioContext.state !== "running"
                ) {
                    return;
                }

                const frames = audioData.numberOfFrames;
                const channels = Math.min(audioData.numberOfChannels, 2);

                if (frames <= 0 || channels <= 0) {
                    return;
                }

                const left = new Float32Array(frames);
                const right = new Float32Array(frames);

                audioData.copyTo(left, {
                    planeIndex: 0,
                    format: "f32-planar",
                });

                if (channels > 1) {
                    audioData.copyTo(right, {
                        planeIndex: 1,
                        format: "f32-planar",
                    });
                } else {
                    right.set(left);
                }

                audioWorkletNode.port.postMessage(
                    { type: "audio", left, right },
                    [left.buffer, right.buffer]
                );

                if (!audioHasProducedOutput) {
                    audioHasProducedOutput = true;
                    setAudioHasOutput(true);
                    reportMediaPipelineLog({
                        level: "success",
                        message: "Audio stream đang phát.",
                    });
                }
            } catch (error) {
                console.error("[Mirrune] Không thể chuyển AudioData:", error);
            } finally {
                audioData.close();
            }
        };

        const drainAudioPackets = () => {
            if (
                disposed ||
                drainingAudioPackets ||
                !audioDecoder ||
                audioDecoder.state !== "configured" ||
                audioFailed
            ) {
                return;
            }

            drainingAudioPackets = true;

            try {
                while (
                    pendingAudioPackets.length > 0 &&
                    audioDecoder &&
                    audioDecoder.state === "configured" &&
                    audioDecoder.decodeQueueSize < MAX_AUDIO_DECODER_QUEUE
                    ) {
                    const packet = pendingAudioPackets.shift()!;

                    audioDecoder.decode(
                        new EncodedAudioChunk({
                            type: "key",
                            timestamp: packet.timestamp,
                            data: packet.data,
                        })
                    );
                }
            } catch (error) {
                audioFailed = true;
                setAudioDecoderReady(false);
                setAudioOutputError(`Lỗi giải mã Opus: ${String(error)}`);
                console.error("[Mirrune] Opus decode error:", error);
            } finally {
                drainingAudioPackets = false;
            }
        };

        const configureAudioDecoder = async (channels: number) => {
            if (
                disposed ||
                !audioOutputActive ||
                !audioContext ||
                audioContext.state !== "running" ||
                audioConfiguring ||
                audioFailed
            ) {
                return;
            }

            if (
                audioDecoder &&
                audioDecoder.state === "configured" &&
                audioDecoderConfig?.numberOfChannels === channels
            ) {
                return;
            }

            audioConfiguring = true;

            try {
                if (audioDecoder) {
                    try {
                        audioDecoder.close();
                    } catch {
                        // Ignore an already closed decoder.
                    }
                    audioDecoder = null;
                }

                if (typeof AudioDecoder === "undefined") {
                    throw new Error("WebCodecs AudioDecoder không được hỗ trợ.");
                }

                const config: AudioDecoderConfig = {
                    codec: "opus",
                    sampleRate: 48000,
                    numberOfChannels: channels,
                };

                const support = await AudioDecoder.isConfigSupported(config);

                if (disposed) return;

                if (!support.supported || !support.config) {
                    throw new Error("WebView2 không hỗ trợ giải mã Opus 48 kHz.");
                }

                audioDecoderConfig = support.config;
                audioChannels = channels;

                audioDecoder = new AudioDecoder({
                    output: renderAudioData,
                    error: (error) => {
                        if (disposed) return;

                        audioFailed = true;
                        setAudioDecoderReady(false);
                        setAudioOutputError(`Lỗi Opus decoder: ${error.message}`);
                        reportMediaPipelineLog({
                            level: "error",
                            message: `Audio decoder lỗi: ${error.message}`,
                        });
                        console.error("[Mirrune] AudioDecoder error:", error);
                    },
                });

                audioDecoder.addEventListener("dequeue", drainAudioPackets);
                audioDecoder.configure(support.config);

                setAudioDecoderReady(true);
                setAudioOutputError("");

                console.info("[Mirrune] Opus decoder configured", {
                    sampleRate: 48000,
                    channels,
                });
                reportMediaPipelineLog({
                    level: "info",
                    message: `Audio decoder sẵn sàng (${channels} kênh, 48 kHz).`,
                });

                drainAudioPackets();
            } catch (error) {
                if (!disposed) {
                    audioFailed = true;
                    setAudioDecoderReady(false);
                    setAudioOutputError(String(error));
                    reportMediaPipelineLog({
                        level: "error",
                        message: `Không thể khởi tạo Opus decoder: ${String(error)}`,
                    });
                    console.error("[Mirrune] Không thể khởi tạo Opus decoder:", error);
                }
            } finally {
                audioConfiguring = false;
            }
        };

        const processAudioPacket = (
            payload: Uint8Array,
            flags: number,
            pts: bigint
        ) => {
            if (payload.byteLength === 0 || payload.byteLength > MAX_VIDEO_PACKET_SIZE) {
                return;
            }

            // Packet CONFIG của scrcpy chứa AOPUSHDR + kích thước native-endian
            // + OpusHead. Dữ liệu âm thanh tiếp theo là raw Opus packet,
            // vì vậy không truyền OpusHead vào AudioDecoderConfig.description.
            if ((flags & 0x01) !== 0) {
                try {
                    const channels = parseOpusConfig(payload);
                    audioChannels = channels;

                    if (audioOutputActive && audioContext?.state === "running") {
                        void configureAudioDecoder(channels);
                    }
                } catch (error) {
                    audioFailed = true;
                    setAudioOutputError(String(error));
                    console.error("[Mirrune] Opus config không hợp lệ:", error);
                }
                return;
            }

            if (audioFailed || !audioChannels) {
                return;
            }

            const timestamp =
                pts === 0xffffffffffffffffn
                    ? Math.round(performance.now() * 1000)
                    : Number(pts);

            if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
                return;
            }

            if (
                !audioDecoder ||
                audioDecoder.state !== "configured" ||
                audioConfiguring ||
                !audioOutputActive
            ) {
                pendingAudioPackets.push({
                    data: payload.slice(),
                    timestamp,
                });

                if (pendingAudioPackets.length > MAX_PENDING_AUDIO_PACKETS) {
                    pendingAudioPackets.splice(
                        0,
                        pendingAudioPackets.length - MAX_PENDING_AUDIO_PACKETS
                    );
                }

                return;
            }

            if (audioDecoder.decodeQueueSize >= MAX_AUDIO_DECODER_QUEUE) {
                pendingAudioPackets.push({
                    data: payload.slice(),
                    timestamp,
                });

                if (pendingAudioPackets.length > MAX_PENDING_AUDIO_PACKETS) {
                    pendingAudioPackets.splice(
                        0,
                        pendingAudioPackets.length - MAX_PENDING_AUDIO_PACKETS
                    );
                }

                return;
            }

            try {
                audioDecoder.decode(
                    new EncodedAudioChunk({
                        type: "key",
                        timestamp,
                        data: payload,
                    })
                );
            } catch (error) {
                audioFailed = true;
                setAudioDecoderReady(false);
                setAudioOutputError(`Không thể gửi Opus packet: ${String(error)}`);
                console.error("[Mirrune] Không thể gửi Opus packet:", error);
            }
        };

        // --------------------------------------------------
        // Statistics
        // --------------------------------------------------

        const updateStats = () => {
            if (!disposed) {
                setMediaStats({ ...counters });
            }

            if (disposed) return;

            const now = performance.now();
            const progressInterval = firstFrameRendered ? 10_000 : 5_000;
            if (now - lastVideoProgressLogAt < progressInterval) return;

            lastVideoProgressLogAt = now;
            const packetDelta = counters.videoPackets - lastLoggedVideoPackets;
            const byteDelta = counters.videoBytes - lastLoggedVideoBytes;
            const frameDelta = counters.decodedFrames - lastLoggedDecodedFrames;
            lastLoggedVideoPackets = counters.videoPackets;
            lastLoggedVideoBytes = counters.videoBytes;
            lastLoggedDecodedFrames = counters.decodedFrames;

            const stage = firstFrameRendered
                ? "đang phát"
                : !authenticated
                    ? "đang kết nối/xác thực WebSocket"
                    : !hasVideoConfiguration
                        ? "đang nhận H.264 SPS/PPS"
                        : !hasVideoKeyframeSubmitted
                            ? "đang chờ keyframe để bắt đầu giải mã"
                            : "đang giải mã và chờ render frame đầu";
            reportMediaPipelineLog({
                level: "info",
                message: `Video ${stage}: +${packetDelta.toLocaleString()} packets, +${formatBytes(byteDelta)}, +${frameDelta.toLocaleString()} frames · tổng ${counters.videoPackets.toLocaleString()} packets / ${formatBytes(counters.videoBytes)} / ${counters.decodedFrames.toLocaleString()} frames.`,
            });
        };

        // --------------------------------------------------
        // Canvas
        // --------------------------------------------------

        const clearCanvas = () => {
            const canvas = canvasRef.current;

            if (!canvas) return;

            canvasContext = null;

            canvas.width = 0;
            canvas.height = 0;
            setVideoFrameSize(null);
        };

        const drawFrame = (frame: VideoFrame) => {
            const canvas = canvasRef.current;

            if (!canvas) {
                frame.close();
                return;
            }

            try {
                if (!canvasContext) {
                    canvasContext = canvas.getContext("2d", {
                        alpha: false,
                        desynchronized: true,
                        colorSpace: "srgb",
                    });
                }

                if (!canvasContext) {
                    throw new Error(
                        "Không thể khởi tạo Canvas rendering context."
                    );
                }

                const width = frame.displayWidth || frame.codedWidth;
                const height = frame.displayHeight || frame.codedHeight;

                if (width <= 0 || height <= 0) {
                    return;
                }

                if (canvas.width !== width || canvas.height !== height) {
                    canvas.width = width;
                    canvas.height = height;
                    setVideoFrameSize({ width, height });
                }

                canvasContext.drawImage(frame, 0, 0, width, height);
                counters.decodedFrames += 1;

                if (!firstFrameRendered) {
                    firstFrameRendered = true;
                    setHasVideoFrame(true);
                    setMediaStatus("receiving");
                    setMediaError("");
                    console.info(
                        "[Mirrune] First video frame rendered",
                        `${Math.round(performance.now() - connectionStartedAt)} ms`
                    );
                }
            } catch (error) {
                console.error("Video rendering error:", error);
                setMediaError(String(error));
                setMediaStatus("error");
                reportMediaPipelineLog({
                    level: "error",
                    message: `Không thể render video frame: ${String(error)}`,
                });
            } finally {
                frame.close();
            }
        };

        const renderFrame = (frame: VideoFrame) => {
            if (disposed) {
                frame.close();
                return;
            }

            // The first frame must render synchronously: requestAnimationFrame
            // may be throttled while the new Tauri window is still hidden.
            if (counters.decodedFrames === 0) {
                if (videoFrameRaf !== undefined) {
                    window.cancelAnimationFrame(videoFrameRaf);
                    videoFrameRaf = undefined;
                }
                latestVideoFrame?.close();
                latestVideoFrame = null;
                drawFrame(frame);
                return;
            }

            latestVideoFrame?.close();
            latestVideoFrame = frame;

            if (videoFrameRaf !== undefined) {
                return;
            }

            videoFrameRaf = window.requestAnimationFrame(() => {
                videoFrameRaf = undefined;
                const currentFrame = latestVideoFrame;
                latestVideoFrame = null;

                if (!currentFrame || disposed) {
                    currentFrame?.close();
                    return;
                }

                drawFrame(currentFrame);
            });
        };

        // --------------------------------------------------
        // Pending packet queue
        // --------------------------------------------------

        const clearPendingPackets = () => {
            pendingVideoPackets = [];
            pendingVideoBytes = 0;
        };

        const enqueueVideoPacket = (
            packet: PendingVideoPacket
        ) => {
            const packetSize = packet.data.byteLength;

            if (
                packetSize > MAX_PENDING_VIDEO_BYTES ||
                packetSize > MAX_VIDEO_PACKET_SIZE
            ) {
                waitingForKeyframe = true;
                clearPendingPackets();
                return;
            }

            if (
                pendingVideoPackets.length + 1 >
                MAX_PENDING_VIDEO_PACKETS ||
                pendingVideoBytes + packetSize >
                MAX_PENDING_VIDEO_BYTES
            ) {
                // Không giữ GOP cũ khi hàng đợi vượt giới hạn.
                // Chờ keyframe mới để khôi phục chuỗi tham chiếu.
                clearPendingPackets();

                waitingForKeyframe = true;

                if (!packet.keyframe) {
                    return;
                }
            }

            pendingVideoPackets.push(packet);

            pendingVideoBytes += packetSize;
        };

        // --------------------------------------------------
        // Decoder lifecycle
        // --------------------------------------------------

        const closeDecoder = () => {
            if (videoFrameRaf !== undefined) {
                window.cancelAnimationFrame(videoFrameRaf);
                videoFrameRaf = undefined;
            }

            if (latestVideoFrame) {
                latestVideoFrame.close();
                latestVideoFrame = null;
            }

            if (decoder) {
                try {
                    decoder.close();
                } catch {
                    // Decoder may already be closed.
                }

                decoder = null;
            }

            decoderConfig = null;
            configuringDecoder = false;
            decoderFailed = false;

            waitingForKeyframe = true;

            clearPendingPackets();
        };

        // --------------------------------------------------
        // Encoded packet submission
        // --------------------------------------------------

        const submitVideoPacket = (
            packet: PendingVideoPacket
        ): boolean => {
            if (
                disposed ||
                !decoder ||
                !decoderConfig ||
                decoder.state !== "configured" ||
                decoderFailed
            ) {
                return false;
            }

            if (waitingForKeyframe && !packet.keyframe) {
                return false;
            }

            if (decoder.decodeQueueSize >= MAX_DECODER_QUEUE) {
                return false;
            }

            try {
                const encodedData =
                    convertAnnexBToAvcc(packet.data);

                decoder.decode(
                    new EncodedVideoChunk({
                        type: packet.keyframe ? "key" : "delta",
                        timestamp: packet.timestamp,
                        data: encodedData,
                    })
                );

                if (packet.keyframe) {
                    waitingForKeyframe = false;
                    if (!hasVideoKeyframeSubmitted) {
                        hasVideoKeyframeSubmitted = true;
                        reportMediaPipelineLog({
                            level: "info",
                            message: "Video keyframe đã được gửi vào decoder; đang chờ frame render.",
                        });
                    }
                }

                return true;
            } catch (error) {
                console.error(
                    "Không thể đưa packet vào H.264 decoder:",
                    error
                );

                waitingForKeyframe = true;

                return false;
            }
        };

        // --------------------------------------------------
        // Pending queue draining
        // --------------------------------------------------

        const drainPendingPackets = () => {
            if (
                disposed ||
                drainingPending ||
                !decoder ||
                decoder.state !== "configured" ||
                decoderFailed
            ) {
                return;
            }

            drainingPending = true;

            try {
                // Khi decoder mất reference chain,
                // bỏ toàn bộ packet trước keyframe gần nhất.
                if (waitingForKeyframe) {
                    const keyframeIndex =
                        pendingVideoPackets.findIndex(
                            (packet) => packet.keyframe
                        );

                    if (keyframeIndex === -1) {
                        return;
                    }

                    if (keyframeIndex > 0) {
                        pendingVideoPackets.splice(
                            0,
                            keyframeIndex
                        );

                        pendingVideoBytes =
                            pendingVideoPackets.reduce(
                                (total, packet) =>
                                    total + packet.data.byteLength,
                                0
                            );
                    }
                }

                while (
                    pendingVideoPackets.length > 0 &&
                    decoder &&
                    decoder.state === "configured" &&
                    decoder.decodeQueueSize < MAX_DECODER_QUEUE
                    ) {
                    const packet = pendingVideoPackets.shift()!;

                    pendingVideoBytes -= packet.data.byteLength;

                    const submitted =
                        submitVideoPacket(packet);

                    if (!submitted) {
                        if (packet.keyframe) {
                            waitingForKeyframe = true;
                        }

                        break;
                    }
                }
            } finally {
                drainingPending = false;
            }
        };

        // --------------------------------------------------
        // Decoder initialization
        // --------------------------------------------------

        const configureDecoder = async (
            configuration: AvcConfiguration
        ) => {
            if (disposed || configuringDecoder || decoderFailed) {
                return;
            }

            if (
                decoder &&
                decoder.state === "configured" &&
                sameConfiguration(
                    activeAvcConfiguration,
                    configuration
                )
            ) {
                return;
            }

            configuringDecoder = true;

            try {
                closeDecoder();

                configuringDecoder = true;

                if (typeof VideoDecoder === "undefined") {
                    throw new Error(
                        "WebCodecs không được hỗ trợ trên WebView2 hiện tại."
                    );
                }

                const baseConfig: VideoDecoderConfig = {
                    codec: configuration.codec,
                    description: configuration.description,
                    optimizeForLatency: true,
                };

                const candidates: VideoDecoderConfig[] = [
                    {
                        ...baseConfig,
                        hardwareAcceleration: "prefer-hardware",
                    },
                    {
                        ...baseConfig,
                        hardwareAcceleration: "no-preference",
                    },
                ];

                let supportedConfig: VideoDecoderConfig | null = null;

                let accelerationLabel = "";

                for (const candidate of candidates) {
                    const support =
                        await VideoDecoder.isConfigSupported(candidate);

                    if (disposed) return;

                    if (support.supported && support.config) {
                        supportedConfig = support.config;

                        accelerationLabel =
                            candidate.hardwareAcceleration ===
                            "prefer-hardware"
                                ? "HARDWARE PREFERRED"
                                : "AUTOMATIC";

                        break;
                    }
                }

                if (!supportedConfig) {
                    throw new Error(
                        `WebCodecs không hỗ trợ cấu hình H.264 ${configuration.codec}.`
                    );
                }

                decoderConfig = supportedConfig;

                activeAvcConfiguration = configuration;

                decoderFailed = false;

                decoder = new VideoDecoder({
                    output: renderFrame,

                    error: (error) => {
                        if (disposed) return;

                        console.error(
                            "H.264 decoder error:",
                            error
                        );

                        decoderFailed = true;

                        waitingForKeyframe = true;

                        clearPendingPackets();

                        setDecoderLabel("DECODER ERROR");

                        setMediaError(
                            `Lỗi giải mã H.264: ${error.message}`
                        );

                        setMediaStatus("error");
                        reportMediaPipelineLog({
                            level: "error",
                            message: `Video decoder lỗi: ${error.message}`,
                        });
                    },
                });

                decoder.addEventListener(
                    "dequeue",
                    drainPendingPackets
                );

                decoder.configure(supportedConfig);

                waitingForKeyframe = true;

                setDecoderLabel(accelerationLabel);

                setMediaError("");

                console.info(
                    "[Mirrune] H.264 decoder configured",
                    {
                        codec: configuration.codec,
                        acceleration: accelerationLabel,
                        hardwareAcceleration:
                        supportedConfig.hardwareAcceleration,
                    }
                );
                reportMediaPipelineLog({
                    level: "info",
                    message: `H.264 decoder đã cấu hình (${accelerationLabel}).`,
                });

                // Xử lý các packet đã đến trong lúc
                // isConfigSupported đang chạy.
                drainPendingPackets();
            } catch (error) {
                if (!disposed) {
                    console.error(
                        "Không thể khởi tạo H.264 decoder:",
                        error
                    );

                    decoderFailed = true;

                    clearPendingPackets();

                    setDecoderLabel("UNAVAILABLE");

                    setMediaError(String(error));

                    setMediaStatus("error");
                    reportMediaPipelineLog({
                        level: "error",
                        message: `Không thể cấu hình H.264 decoder: ${String(error)}`,
                    });
                }
            } finally {
                configuringDecoder = false;
            }
        };

        // --------------------------------------------------
        // H.264 configuration extraction
        // --------------------------------------------------

        const updateCodecConfiguration = (
            units: Uint8Array[]
        ) => {
            const incomingSps = units.filter(
                (unit) => getNalType(unit) === 7
            );

            const incomingPps = units.filter(
                (unit) => getNalType(unit) === 8
            );

            if (incomingSps.length > 0) {
                spsUnits = incomingSps.map(
                    (unit) => unit.slice()
                );
            }

            if (incomingPps.length > 0) {
                ppsUnits = incomingPps.map(
                    (unit) => unit.slice()
                );
            }

            if (
                spsUnits.length === 0 ||
                ppsUnits.length === 0
            ) {
                return;
            }

            try {
                const configuration =
                    createAvcConfiguration(
                        spsUnits,
                        ppsUnits
                    );
                hasVideoConfiguration = true;

                if (
                    decoder &&
                    decoder.state === "configured" &&
                    sameConfiguration(
                        activeAvcConfiguration,
                        configuration
                    )
                ) {
                    return;
                }

                void configureDecoder(configuration);
            } catch (error) {
                console.error(
                    "Không thể đọc H.264 SPS/PPS:",
                    error
                );

                setMediaError(String(error));
            }
        };

        // --------------------------------------------------
        // Video packet processing
        // --------------------------------------------------

        const processVideoPacket = (
            payload: Uint8Array,
            flags: number,
            pts: bigint
        ) => {
            if (
                payload.byteLength === 0 ||
                payload.byteLength > MAX_VIDEO_PACKET_SIZE
            ) {
                return;
            }

            const units = splitAnnexB(payload);

            if (units.length === 0) {
                return;
            }

            const hasSps = hasNalType(units, 7);
            const hasPps = hasNalType(units, 8);

            const isConfig =
                (flags & 0x01) !== 0 ||
                hasSps ||
                hasPps;

            const hasVideoFrame = units.some((unit) => {
                const type = getNalType(unit);

                return type >= 1 && type <= 5;
            });

            if (isConfig) {
                updateCodecConfiguration(units);
            }

            // CONFIG packet thông thường chỉ chứa SPS/PPS.
            // Nếu cùng packet có IDR thì vẫn tiếp tục xử lý frame.
            if (!hasVideoFrame) {
                return;
            }

            const isKeyframe =
                (flags & 0x02) !== 0 ||
                isKeyframePacket(units);

            const timestamp =
                pts === 0xffffffffffffffffn
                    ? Math.round(performance.now() * 1000)
                    : Number(pts);

            if (
                !Number.isSafeInteger(timestamp) ||
                timestamp < 0
            ) {
                console.warn("PTS không hợp lệ:", pts.toString());
                return;
            }

            // Copy payload vì packet tạm sẽ tồn tại
            // trong hàng đợi sau khi callback kết thúc.
            const packet: PendingVideoPacket = {
                data: payload.slice(),
                timestamp,
                keyframe: isKeyframe,
            };

            if (
                !decoder ||
                decoder.state !== "configured" ||
                configuringDecoder ||
                decoderFailed
            ) {
                enqueueVideoPacket(packet);

                return;
            }

            if (
                pendingVideoPackets.length > 0 ||
                decoder.decodeQueueSize >= MAX_DECODER_QUEUE
            ) {
                enqueueVideoPacket(packet);

                drainPendingPackets();

                return;
            }

            const submitted = submitVideoPacket(packet);

            if (!submitted) {
                enqueueVideoPacket(packet);
                drainPendingPackets();
            }
        };

        // --------------------------------------------------
        // MRN1 packet processing
        // --------------------------------------------------

        const processBinaryPacket = (buffer: ArrayBuffer) => {
            if (buffer.byteLength < 20) {
                console.warn("[Mirrune] Media packet quá ngắn.");
                return;
            }

            const bytes = new Uint8Array(buffer);
            const view = new DataView(buffer);

            if (
                bytes[0] !== 0x4d ||
                bytes[1] !== 0x52 ||
                bytes[2] !== 0x4e ||
                bytes[3] !== 0x31
            ) {
                console.warn(
                    "[Mirrune] Media packet signature không hợp lệ."
                );

                return;
            }

            const streamType = view.getUint8(4);
            const flags = view.getUint8(5);

            // Generation echoed by the backend in MRN1 header bytes 6-7.
            // On reconnect the generation changes: reset decoder state so
            // stale SPS/PPS/config/keyframe state from the previous session
            // is never applied to the current media stream.
            const frameGeneration = view.getUint16(6, false);

            const pts = view.getBigUint64(8, false);

            const payloadLength = view.getUint32(16, false);

            if (
                payloadLength !== buffer.byteLength - 20 ||
                payloadLength > MAX_VIDEO_PACKET_SIZE
            ) {
                console.warn(
                    "[Mirrune] Media packet payload không hợp lệ."
                );

                return;
            }

            const payload = bytes.subarray(20);

            // Phát hiện phiên kết nối mới qua generation. Nếu generation
            // thay đổi (reconnect), thiết bị giải mã của phiên cũ không
            // bao giờ được áp dụng nhầm cho phiên mới.
            if (currentGeneration !== null && frameGeneration !== currentGeneration) {
                console.info(
                    "[Mirrune] Phát hiện reconnect (generation",
                    currentGeneration,
                    "→",
                    frameGeneration,
                    "). Đặt lại trạng thái giải mã."
                );

                currentGeneration = frameGeneration;

                closeDecoder();
                closeAudioDecoder();

                spsUnits = [];
                ppsUnits = [];

                activeAvcConfiguration = null;

                waitingForKeyframe = true;

                clearPendingPackets();
                clearPendingAudioPackets();

                clearCanvas();

                setHasVideoFrame(false);
                setMediaStatus("ready");
                setMediaError("");

                setDecoderLabel("INITIALIZING");

                if (!disposed) {
                    setAudioDecoderReady(false);
                    setAudioHasOutput(false);
                }

                audioWorkletNode?.port.postMessage({ type: "flush" });
            } else if (currentGeneration === null) {
                currentGeneration = frameGeneration;
            }

            switch (streamType) {
                case 1: {
                    counters.videoPackets += 1;
                    counters.videoBytes += payloadLength;

                    processVideoPacket(
                        payload,
                        flags,
                        pts
                    );

                    break;
                }

                case 2: {
                    counters.audioPackets += 1;
                    counters.audioBytes += payloadLength;

                    processAudioPacket(payload, flags, pts);

                    break;
                }

                case 3: {
                    if (payloadLength < 9) {
                        console.warn(
                            "[Mirrune] Video session packet không hợp lệ."
                        );

                        return;
                    }

                    const sessionView = new DataView(
                        payload.buffer,
                        payload.byteOffset,
                        payload.byteLength
                    );

                    const width = sessionView.getUint32(0, false);
                    const height = sessionView.getUint32(4, false);

                    if (
                        width === 0 ||
                        height === 0 ||
                        width > 16384 ||
                        height > 16384
                    ) {
                        console.warn(
                            "[Mirrune] Độ phân giải video không hợp lệ."
                        );

                        return;
                    }

                    setMediaInfo((previous) => {
                        if (!previous) return previous;

                        return {
                            ...previous,
                            metadata: {
                                ...previous.metadata,
                                videoWidth: width,
                                videoHeight: height,
                            },
                        };
                    });

                    break;
                }

                case 4: {
                    const message =
                        new TextDecoder().decode(payload);

                    console.error(
                        "[Mirrune] Scrcpy media error:",
                        message
                    );

                    setMediaError(message);

                    break;
                }

                default:
                    console.warn(
                        "[Mirrune] Stream type không hỗ trợ:",
                        streamType
                    );

                    return;
            }

            counters.totalBytes += payloadLength;

            if (streamType === 1 || streamType === 2) {
                setMediaStatus((previous) =>
                    previous === "error"
                        ? previous
                        : "receiving"
                );
            }
        };

        // --------------------------------------------------
        // Reconnection
        // --------------------------------------------------

        const scheduleReconnect = (delay = RECONNECT_DELAY) => {
            if (disposed || retryTimer !== undefined) {
                return;
            }

            retryTimer = window.setTimeout(() => {
                retryTimer = undefined;

                if (!disposed) {
                    void connect();
                }
            }, delay);
        };

        // --------------------------------------------------
        // WebSocket
        // --------------------------------------------------

        const connect = async () => {
            if (disposed) return;

            connectionStartedAt = performance.now();
            firstFrameRendered = false;
            hasVideoConfiguration = false;
            hasVideoKeyframeSubmitted = false;
            lastVideoProgressLogAt = 0;
            authenticated = false;

            closeDecoder();
            closeAudioDecoder();

            spsUnits = [];
            ppsUnits = [];

            activeAvcConfiguration = null;

            clearCanvas();

            setHasVideoFrame(false);

            setMediaStatus("connecting");

            setMediaError("");

            setDecoderLabel("INITIALIZING");

            try {
                const info = await invoke<ScrcpyMediaInfo | null>(
                    "get_android_media_info"
                );

                if (disposed) return;

                if (!info) {
                    if (!waitingForSessionLogged) {
                        waitingForSessionLogged = true;
                        reportMediaPipelineLog({
                            level: "info",
                            message: "Đang chờ media endpoint từ scrcpy.",
                        });
                    }
                    setMediaStatus("connecting");
                    setMediaError("");
                    scheduleReconnect(100);
                    return;
                }

                waitingForSessionLogged = false;
                if (
                    !Number.isInteger(info.port) ||
                    info.port <= 0 ||
                    info.port > 65535 ||
                    !info.token
                ) {
                    throw new Error(
                        "Thông tin kết nối media không hợp lệ."
                    );
                }

                setMediaInfo(info);
                reportMediaPipelineLog({
                    level: "info",
                    message: `Media endpoint sẵn sàng (${info.metadata.videoWidth}x${info.metadata.videoHeight}).`,
                });
                console.info(
                    "[Mirrune] Media session info ready",
                    `${Math.round(performance.now() - connectionStartedAt)} ms`
                );

                if (
                    info.metadata.videoCodec.toLowerCase() !== "h264"
                ) {
                    throw new Error(
                        `Codec video không được hỗ trợ: ${info.metadata.videoCodec}`
                    );
                }

                const ws = new WebSocket(
                    `ws://127.0.0.1:${info.port}`
                );

                socket = ws;

                ws.binaryType = "arraybuffer";

                ws.onopen = () => {
                    if (disposed) {
                        ws.close();
                        return;
                    }

                    console.info(
                        "[Mirrune] Media WebSocket connected",
                        `${Math.round(performance.now() - connectionStartedAt)} ms`
                    );
                    reportMediaPipelineLog({
                        level: "info",
                        message: "WebSocket media đã kết nối; đang xác thực.",
                    });
                    setMediaStatus("authenticating");

                    ws.send(info.token);
                };

                ws.onmessage = (event: MessageEvent) => {
                    if (disposed) return;

                    if (typeof event.data === "string") {
                        const readyMatch = /^MIRRUNE_READY (\d+)$/.exec(
                            event.data
                        );

                        if (readyMatch) {
                            authenticated = true;

                            const generation = Number(readyMatch[1]);

                            if (
                                !Number.isSafeInteger(generation) ||
                                generation < 0
                            ) {
                                console.warn(
                                    "[Mirrune] Generation không hợp lệ:",
                                    event.data
                                );

                                return;
                            }

                            currentGeneration = generation;

                            setMediaStatus("ready");

                            setMediaError("");
                            reportMediaPipelineLog({
                                level: "info",
                                message: "Kênh media đã xác thực; đang chờ frame H.264.",
                            });

                            console.info(
                                "[Mirrune] Media WebSocket authenticated. Generation:",
                                generation,
                                `${Math.round(performance.now() - connectionStartedAt)} ms`
                            );

                            return;
                        }

                        console.warn(
                            "[Mirrune] WebSocket server:",
                            event.data
                        );

                        return;
                    }

                    if (!authenticated) {
                        console.warn(
                            "[Mirrune] Nhận media trước khi xác thực."
                        );

                        return;
                    }

                    if (event.data instanceof ArrayBuffer) {
                        processBinaryPacket(event.data);
                    }
                };

                ws.onerror = () => {
                    if (!disposed) {
                        setMediaError(
                            "Không thể giao tiếp với media server."
                        );
                    }
                };

                ws.onclose = (event) => {
                    if (disposed) return;

                    authenticated = false;

                    closeDecoder();
                    closeAudioDecoder();

                    spsUnits = [];
                    ppsUnits = [];

                    activeAvcConfiguration = null;

                    clearCanvas();

                    setHasVideoFrame(false);

                    setMediaStatus("disconnected");
                    reportMediaPipelineLog({
                        level: "warning",
                        message: "WebSocket media đóng; đang thử kết nối lại.",
                    });

                    console.warn(
                        "[Mirrune] Media WebSocket closed:",
                        {
                            code: event.code,
                            reason: event.reason,
                            clean: event.wasClean,
                        }
                    );

                    scheduleReconnect();
                };
            } catch (error) {
                if (disposed) return;

                closeDecoder();
                closeAudioDecoder();

                setMediaStatus("disconnected");

                setMediaError(String(error));
                reportMediaPipelineLog({
                    level: "warning",
                    message: `Media reconnect: ${String(error)}`,
                });

                scheduleReconnect();
            }
        };

        statsTimer = window.setInterval(
            updateStats,
            STATS_INTERVAL
        );

        void connect();

        return () => {
            disposed = true;
            activateAudioRef.current = null;

            if (retryTimer !== undefined) {
                window.clearTimeout(retryTimer);
            }

            if (statsTimer !== undefined) {
                window.clearInterval(statsTimer);
            }

            closeDecoder();
            closeAudioDecoder();

            audioOutputActive = false;
            audioHasProducedOutput = false;

            if (audioWorkletNode) {
                audioWorkletNode.port.postMessage({ type: "flush" });
                audioWorkletNode.disconnect();
                audioWorkletNode = null;
            }

            if (audioContext) {
                void audioContext.close();
                audioContext = null;
            }

            clearCanvas();

            if (socket) {
                socket.onopen = null;
                socket.onmessage = null;
                socket.onerror = null;
                socket.onclose = null;

                socket.close();
            }
        };
    }, [reconnectKey]);

    // Reveal the window when video is actually decoded and rendered. Audio
    // initialization must not delay the video-first startup path.
    useEffect(() => {
        if (hasShownWindow) return;

        const mediaReady = hasVideoFrame;
        const failed = mediaStatus === "error" || mediaStatus === "disconnected";

        if (!mediaReady && !failed) return;

        let cancelled = false;
        void (async () => {
            try {
                await screenWindow.show();
                if (cancelled) return;
                if (!(await screenWindow.isVisible())) {
                    throw new Error("Viewer chưa chuyển sang trạng thái hiển thị.");
                }
                await screenWindow.setFocus();
                if (cancelled) return;

                await invoke("mark_android_streaming");
                if (cancelled) return;

                setHasShownWindow(true);
                reportMediaPipelineLog({
                    level: "success",
                    message: "Cửa sổ viewer đã hiển thị; frame video đầu đã render.",
                    ready: true,
                });
            } catch (error) {
                if (cancelled) return;
                setMediaError(`Không thể mở cửa sổ viewer: ${String(error)}`);
                setMediaStatus("error");
                reportMediaPipelineLog({
                    level: "error",
                    message: `Không thể hiển thị video: ${String(error)}`,
                });
                console.error("Không thể hiển thị Device Screen:", error);
            }
        })();

        return () => { cancelled = true; };
    }, [
        hasShownWindow,
        hasVideoFrame,
        mediaStatus,
        screenWindow,
    ]);

    useEffect(() => {
        if (!hasShownWindow) return;

        const activateAudio = activateAudioRef.current;
        if (!activateAudio) return;

        void activateAudio().catch((error) => {
            setAudioOutputEnabled(false);
            setAudioDecoderReady(false);
            setAudioOutputError(String(error));
            reportMediaPipelineLog({
                level: "warning",
                message: `Tự kích hoạt audio thất bại; cần thao tác bật lại: ${String(error)}`,
            });
            console.error("[Mirrune] Không thể tự khởi tạo âm thanh:", error);
        });
    }, [hasShownWindow, reconnectKey]);

    // Không chờ vô hạn nếu thiết bị không phát keyframe hoặc decoder lỗi im lặng.
    useEffect(() => {
        if (
            !mediaInfo ||
            hasVideoFrame ||
            mediaStatus === "error" ||
            mediaStatus === "disconnected"
        ) {
            return;
        }

        const timer = window.setTimeout(() => {
            const timeoutMessage =
                "Quá thời gian chờ khung hình H.264 (15 giây). Kiểm tra SPS/PPS, keyframe và trạng thái decoder.";
            setMediaStatus("error");
            setDecoderLabel((current) =>
                current === "INITIALIZING" ? "STARTUP TIMEOUT" : current
            );
            setMediaError((current) =>
                current || timeoutMessage
            );
            reportMediaPipelineLog({
                level: "error",
                message: timeoutMessage,
            });
        }, VIDEO_STARTUP_TIMEOUT);

        return () => window.clearTimeout(timer);
    }, [hasVideoFrame, mediaInfo, mediaStatus, reconnectKey]);

    // ==================================================
    // Actions
    // ==================================================

    const retryConnection = useCallback(() => {
        setMediaStatus("initializing");

        setMediaError("");

        setMediaInfo(null);

        setMediaStats({ ...INITIAL_STATS });

        setHasVideoFrame(false);

        setAudioOutputEnabled(false);
        setAudioDecoderReady(false);
        setAudioHasOutput(false);
        setAudioOutputError("");

        setDecoderLabel("INITIALIZING");

        setReconnectKey((value) => value + 1);
    }, []);

    const resizeFullscreenWindow = useCallback(
        async (
            videoWidth: number,
            videoHeight: number,
            rollbackOnFailure: boolean,
        ): Promise<boolean | null> => {
            if (fullscreenTransitionRef.current) {
                return null;
            }

            fullscreenTransitionRef.current = true;
            try {
                const [
                    innerSize,
                    outerSize,
                    outerPosition,
                    scaleFactor,
                    monitor,
                ] = await Promise.all([
                    screenWindow.innerSize(),
                    screenWindow.outerSize(),
                    screenWindow.outerPosition(),
                    screenWindow.scaleFactor(),
                    currentMonitor(),
                ]);
                if (!monitor) {
                    throw new Error("Không xác định được màn hình hiện tại.");
                }
                originalWindowBoundsRef.current ??= {
                    size: innerSize,
                    position: outerPosition,
                };

                const screenBounds = window.screen as Screen & {
                    availLeft?: number;
                    availTop?: number;
                };
                const decorationWidth = Math.max(
                    0,
                    (outerSize.width - innerSize.width) / scaleFactor,
                );
                const decorationHeight = Math.max(
                    0,
                    (outerSize.height - innerSize.height) / scaleFactor,
                );
                const margin = 16;
                const maxInnerWidth = Math.max(
                    1,
                    screenBounds.availWidth - decorationWidth - margin,
                );
                const maxInnerHeight = Math.max(
                    1,
                    screenBounds.availHeight - decorationHeight - margin,
                );
                const aspectRatio = videoWidth / videoHeight;
                const targetInnerWidth = Math.min(
                    maxInnerWidth,
                    maxInnerHeight * aspectRatio,
                );
                const targetInnerHeight = targetInnerWidth / aspectRatio;
                const targetOuterWidth =
                    targetInnerWidth + decorationWidth;
                const targetOuterHeight =
                    targetInnerHeight + decorationHeight;
                const availableLeft =
                    screenBounds.availLeft ??
                    monitor.position.x / monitor.scaleFactor;
                const availableTop =
                    screenBounds.availTop ??
                    monitor.position.y / monitor.scaleFactor;
                const targetLeft =
                    availableLeft +
                    (screenBounds.availWidth - targetOuterWidth) / 2;
                const targetTop =
                    availableTop +
                    (screenBounds.availHeight - targetOuterHeight) / 2;

                await screenWindow.setMinSize(null);
                await screenWindow.setSize(
                    new LogicalSize(
                        Math.round(targetInnerWidth),
                        Math.round(targetInnerHeight),
                    ),
                );
                await screenWindow.setPosition(
                    new LogicalPosition(
                        Math.round(targetLeft),
                        Math.round(targetTop),
                    ),
                );
                fullscreenAspectRatioRef.current = aspectRatio;
                return true;
            } catch (error) {
                if (rollbackOnFailure) {
                    const originalBounds = originalWindowBoundsRef.current;
                    if (originalBounds) {
                        try {
                            await screenWindow.setMinSize(null);
                            await screenWindow.setSize(originalBounds.size);
                            await screenWindow.setPosition(
                                originalBounds.position,
                            );
                            await screenWindow.setMinSize(
                                new LogicalSize(480, 360),
                            );
                            originalWindowBoundsRef.current = null;
                        } catch (restoreError) {
                            reportMediaPipelineLog({
                                level: "error",
                                message: `Không thể khôi phục kích thước cửa sổ sau lỗi: ${String(restoreError)}`,
                            });
                        }
                    }
                }
                reportMediaPipelineLog({
                    level: "error",
                    message: `Không thể căn chỉnh cửa sổ theo video: ${String(error)}`,
                });
                return false;
            } finally {
                fullscreenTransitionRef.current = false;
            }
        },
        [screenWindow],
    );

    const exitVideoFullscreen = useCallback(async () => {
        if (fullscreenTransitionRef.current) {
            return;
        }

        fullscreenTransitionRef.current = true;
        const originalBounds = originalWindowBoundsRef.current;

        try {
            if (originalBounds) {
                await screenWindow.setMinSize(null);
                await screenWindow.setSize(originalBounds.size);
                await screenWindow.setPosition(originalBounds.position);
                await screenWindow.setMinSize(new LogicalSize(480, 360));
                originalWindowBoundsRef.current = null;
            }
        } catch (error) {
            reportMediaPipelineLog({
                level: "error",
                message: `Không thể khôi phục kích thước cửa sổ: ${String(error)}`,
            });
        } finally {
            fullscreenAspectRatioRef.current = null;
            setIsVideoFullscreen(false);
            fullscreenTransitionRef.current = false;
        }
    }, [screenWindow]);

    const toggleVideoFullscreen = useCallback(async () => {
        if (fullscreenTransitionRef.current) {
            return;
        }

        if (isVideoFullscreen) {
            await exitVideoFullscreen();
            return;
        }

        const canvas = canvasRef.current;
        const videoWidth =
            videoFrameSize?.width ||
            canvas?.width ||
            mediaInfo?.metadata.videoWidth ||
            0;
        const videoHeight =
            videoFrameSize?.height ||
            canvas?.height ||
            mediaInfo?.metadata.videoHeight ||
            0;

        if (videoWidth <= 0 || videoHeight <= 0) {
            reportMediaPipelineLog({
                level: "warning",
                message: "Chưa có kích thước video để căn chỉnh cửa sổ.",
            });
            setIsVideoFullscreen(true);
            return;
        }

        const resized = await resizeFullscreenWindow(
            videoWidth,
            videoHeight,
            true,
        );
        if (resized) {
            setIsVideoFullscreen(true);
        }
    }, [
        exitVideoFullscreen,
        isVideoFullscreen,
        mediaInfo,
        resizeFullscreenWindow,
        videoFrameSize,
    ]);

    useEffect(() => {
        if (!isVideoFullscreen || !videoFrameSize) {
            return;
        }

        const aspectRatio =
            videoFrameSize.width / videoFrameSize.height;
        if (fullscreenAspectRatioRef.current === aspectRatio) {
            return;
        }

        let cancelled = false;
        let retryTimer: number | undefined;

        const resize = async () => {
            const result = await resizeFullscreenWindow(
                videoFrameSize.width,
                videoFrameSize.height,
                false,
            );
            if (result === null && !cancelled) {
                retryTimer = window.setTimeout(() => {
                    void resize();
                }, 100);
            }
        };

        void resize();
        return () => {
            cancelled = true;
            if (retryTimer !== undefined) {
                window.clearTimeout(retryTimer);
            }
        };
    }, [isVideoFullscreen, resizeFullscreenWindow, videoFrameSize]);

    const enableAudioOutput = async () => {
        const activateAudio = activateAudioRef.current;
        if (!activateAudio) {
            setAudioOutputError("Audio pipeline chưa sẵn sàng.");
            return;
        }

        try {
            await activateAudio();
        } catch (error) {
            setAudioOutputEnabled(false);
            setAudioOutputError(String(error));
            reportMediaPipelineLog({
                level: "error",
                message: `Không thể bật audio: ${String(error)}`,
            });
        }
    };

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "F11") {
                event.preventDefault();
                void toggleVideoFullscreen();
            } else if (event.key === "Escape" && isVideoFullscreen) {
                event.preventDefault();
                void exitVideoFullscreen();
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [exitVideoFullscreen, isVideoFullscreen, toggleVideoFullscreen]);

    // ==================================================
    // Status presentation
    // ==================================================

    const statusLabel: Record<MediaStatus, string> = {
        initializing: "MEDIA INITIALIZING",
        connecting: "CONNECTING",
        authenticating: "AUTHENTICATING",
        ready: "WEBSOCKET READY",
        receiving: "MEDIA RECEIVING",
        disconnected: "DISCONNECTED",
        error: "MEDIA ERROR",
    };

    const videoStatus = hasVideoFrame
        ? "DECODING"
        : mediaStats.videoPackets > 0
            ? "WAITING"
            : isMediaReady
                ? "WAITING"
                : "INITIALIZING";

    const audioStatus = audioOutputError
        ? "ERROR"
        : audioHasOutput && audioDecoderReady && audioOutputEnabled
            ? "PLAYING"
            : audioDecoderReady && audioOutputEnabled
                ? "READY"
                : mediaStats.audioPackets > 0
                    ? audioOutputEnabled
                        ? "DECODING"
                        : "MUTED"
                    : isMediaReady
                        ? "WAITING"
                        : "INITIALIZING";

    return (
        <main className={`device-screen${isVideoFullscreen ? " video-stream-fullscreen" : ""}`}>
            <header className="screen-header">
                <div className="screen-brand">
                    <img
                        className="screen-brand-logo"
                        src="/logo/svg/primary-logo-transparent.svg"
                        alt="MIRRUNE — Screen Audio Bridge"
                    />
                </div>

                <div className="screen-connection-status">
                    <span className="screen-status-dot" />
                    USB SESSION
                </div>

                <button
                    className="window-control-button"
                    onClick={toggleVideoFullscreen}
                    title={
                        isVideoFullscreen
                            ? "Thoát toàn màn hình video (Esc/F11)"
                            : "Toàn màn hình video (F11)"
                    }
                    aria-label={
                        isVideoFullscreen
                            ? "Thoát toàn màn hình video"
                            : "Toàn màn hình video"
                    }
                >
                    {isVideoFullscreen ? (
                        <Minimize2 size={15} />
                    ) : (
                        <Maximize2 size={15} />
                    )}
                </button>
            </header>

            <section className="screen-workspace">
                <div className="screen-toolbar">
                    <div>
                        <span className="screen-overline">
                            LIVE DISPLAY
                        </span>

                        <h1>Device Screen</h1>
                    </div>

                    <div className="screen-toolbar-actions">
                        <span className="screen-media-badge">
                            <Activity size={13} />
                            {statusLabel[mediaStatus]}
                        </span>
                    </div>
                </div>

                <div className="device-display">
                    <canvas
                        ref={canvasRef}
                        className="device-video-canvas"
                        style={{
                            display: hasVideoFrame ? "block" : "none",
                            width: "100%",
                            height: "100%",
                            objectFit: "contain",
                            background: "#08080b",
                        }}
                    />

                    {!hasVideoFrame && (
                        <div className="display-placeholder">
                            <div className="display-placeholder-icon">
                                <MonitorSmartphone size={35} />
                            </div>

                            <h2>
                                {mediaStatus === "error"
                                    ? "Không thể giải mã video"
                                    : mediaStatus === "disconnected"
                                        ? "Mất kết nối media server"
                                        : mediaStatus === "receiving"
                                            ? "Đang chờ khung hình"
                                            : mediaStatus === "ready"
                                                ? "Kênh media đã sẵn sàng"
                                                : mediaStatus === "authenticating"
                                                    ? "Đang xác thực media server"
                                                    : "Đang khởi tạo luồng hình ảnh"}
                            </h2>

                            <p>
                                {mediaError ||
                                    (mediaStatus === "receiving"
                                        ? "Đang nhận dữ liệu H.264 và chờ keyframe hợp lệ."
                                        : "Mirrune đang thiết lập kênh truyền dữ liệu từ thiết bị Android.")}
                            </p>

                            {mediaInfo && (
                                <p>
                                    {mediaInfo.metadata.deviceName}
                                    {" · "}
                                    {mediaInfo.metadata.videoWidth} ×{" "}
                                    {mediaInfo.metadata.videoHeight}
                                    {" · "}
                                    {mediaInfo.metadata.videoCodec.toUpperCase()}
                                    {" · "}
                                    {mediaInfo.metadata.audioCodec?.toUpperCase() ||
                                        "NO AUDIO"}
                                </p>
                            )}

                            <p>
                                Video:{" "}
                                {mediaStats.videoPackets.toLocaleString()} packets
                                {" · "}
                                Audio:{" "}
                                {mediaStats.audioPackets.toLocaleString()} packets
                            </p>

                            <p>
                                Decoded:{" "}
                                {mediaStats.decodedFrames.toLocaleString()} frames
                                {" · "}
                                Total: {formatBytes(mediaStats.totalBytes)}
                            </p>

                            {(
                                mediaStatus === "disconnected" ||
                                mediaStatus === "error"
                            ) && (
                                <button
                                    className="window-control-button"
                                    onClick={retryConnection}
                                >
                                    <RefreshCw size={14} />
                                    Thử kết nối lại
                                </button>
                            )}

                            {mediaStatus !== "error" && (
                                <div className="display-loading">
                                    <span />
                                    <span />
                                    <span />
                                </div>
                            )}
                        </div>
                    )}
                </div>

                <footer className="screen-media-footer">
                    <div className="screen-media-item">
                        <MonitorSmartphone size={15} />
                        <span>VIDEO</span>
                        <strong>{videoStatus}</strong>
                    </div>

                    <div className="screen-media-item">
                        <AudioLines size={15} />
                        <span>AUDIO</span>
                        <strong>{audioStatus}</strong>
                        {(!audioOutputEnabled || audioOutputError) && (
                            <button
                                className="audio-enable-button"
                                onClick={enableAudioOutput}
                                title={audioOutputError || "Bật âm thanh"}
                            >
                                {audioOutputError ? "THỬ LẠI" : "BẬT TIẾNG"}
                            </button>
                        )}
                    </div>


                    <div className="screen-media-item screen-media-volume">
                        <Volume2 size={15} />
                        <span>DECODER</span>
                        <strong>{decoderLabel}</strong>
                    </div>
                </footer>
            </section>
        </main>
    );
}

export default DeviceScreen;