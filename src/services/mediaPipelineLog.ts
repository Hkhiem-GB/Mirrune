import { emitTo } from "@tauri-apps/api/event";

export const MEDIA_PIPELINE_LOG_EVENT = "media-pipeline-log";

export type MediaPipelineLogLevel = "info" | "success" | "warning" | "error";

export interface MediaPipelineLogPayload {
    level: MediaPipelineLogLevel;
    message: string;
    ready?: boolean;
}

export function reportMediaPipelineLog(
    payload: MediaPipelineLogPayload
): void {
    void emitTo("main", MEDIA_PIPELINE_LOG_EVENT, payload).catch((error) => {
        console.error("[Mirrune] Could not report media pipeline log:", error);
    });
}
