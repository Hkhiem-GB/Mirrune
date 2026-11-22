import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { check, type Update, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { getVersion } from "@tauri-apps/api/app";
import { CheckCircle2, AlertTriangle, Download, RefreshCw, X } from "lucide-react";
import "./modals.css";

interface UpdateModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type UpdateStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "installing"
  | "error";

export const UpdateModal: React.FC<UpdateModalProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [currentVersion, setCurrentVersion] = useState("0.1.1");
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [downloadProgress, setDownloadProgress] = useState<{
    downloaded: number;
    total: number;
    percent: number;
  }>({ downloaded: 0, total: 0, percent: 0 });

  const performCheck = useCallback(async () => {
    setStatus("checking");
    setErrorMessage("");
    try {
      const ver = await getVersion().catch(() => "0.1.1");
      setCurrentVersion(ver);

      const update = await check();
      if (!update) {
        setStatus("up-to-date");
        setAvailableUpdate(null);
      } else {
        setAvailableUpdate(update);
        setStatus("available");
      }
    } catch (err) {
      console.error("Update check failed:", err);
      setErrorMessage(String(err));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      void performCheck();
    } else {
      // If closing while update is pending, close the update handle safely
      if (availableUpdate) {
        void availableUpdate.close().catch(() => {});
      }
      setStatus("idle");
      setAvailableUpdate(null);
      setErrorMessage("");
      setDownloadProgress({ downloaded: 0, total: 0, percent: 0 });
    }
  }, [isOpen, performCheck]);

  const handleUpdateNow = async () => {
    if (!availableUpdate) return;
    setStatus("downloading");
    setErrorMessage("");

    let totalBytes = 0;
    let downloadedBytes = 0;

    try {
      await availableUpdate.downloadAndInstall((event: DownloadEvent) => {
        if (event.event === "Started") {
          totalBytes = event.data.contentLength ?? 0;
          setDownloadProgress({ downloaded: 0, total: totalBytes, percent: 0 });
        } else if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
          const percent = totalBytes > 0 ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : 0;
          setDownloadProgress({ downloaded: downloadedBytes, total: totalBytes, percent });
        } else if (event.event === "Finished") {
          setStatus("installing");
        }
      });
    } catch (err) {
      console.error("Update installation failed:", err);
      setErrorMessage(String(err));
      setStatus("error");
    }
  };

  if (!isOpen) return null;

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 MB";
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(1)} MB`;
  };

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="modal-container" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            <RefreshCw size={18} />
            <span>{t("updater.title")}</span>
          </div>
          <button
            className="modal-close-btn"
            onClick={onClose}
            disabled={status === "downloading" || status === "installing"}
            aria-label={t("updater.close")}
          >
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          {status === "checking" && (
            <div className="updater-status-box">
              <RefreshCw size={36} className="updater-spinner" />
              <div style={{ fontWeight: 600 }}>{t("updater.checking")}</div>
            </div>
          )}

          {status === "up-to-date" && (
            <div className="updater-status-box">
              <CheckCircle2 size={42} style={{ color: "var(--success)" }} />
              <div style={{ fontWeight: 700, fontSize: "16px" }}>{t("updater.up_to_date")}</div>
              <div style={{ color: "var(--text-secondary)", fontSize: "13px" }}>
                {t("updater.up_to_date_desc", { version: currentVersion })}
              </div>
              <div className="updater-actions">
                <button className="btn-secondary-action" onClick={onClose}>
                  {t("updater.close")}
                </button>
              </div>
            </div>
          )}

          {status === "available" && availableUpdate && (
            <div className="updater-status-box">
              <Download size={40} style={{ color: "var(--red-bright)" }} />
              <div style={{ fontWeight: 700, fontSize: "16px" }}>{t("updater.available")}</div>
              <div style={{ color: "var(--text-secondary)", fontSize: "13px" }}>
                {t("updater.available_desc", { version: availableUpdate.version })}
              </div>

              {availableUpdate.body && (
                <div style={{ width: "100%", marginTop: "8px" }}>
                  <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-muted)", marginBottom: "6px", textAlign: "left" }}>
                    {t("updater.release_notes")}:
                  </div>
                  <div className="updater-release-notes">
                    {availableUpdate.body || t("updater.no_notes")}
                  </div>
                </div>
              )}

              <div className="updater-actions">
                <button className="btn-secondary-action" onClick={onClose}>
                  {t("updater.later")}
                </button>
                <button className="btn-primary-action" onClick={() => void handleUpdateNow()}>
                  <Download size={14} />
                  <span>{t("updater.update_now")}</span>
                </button>
              </div>
            </div>
          )}

          {status === "downloading" && (
            <div className="updater-status-box">
              <Download size={36} className="updater-spinner" />
              <div style={{ fontWeight: 700 }}>{t("updater.downloading")}</div>
              <div className="updater-progress-container">
                <div className="updater-progress-bar-bg">
                  <div
                    className="updater-progress-bar-fill"
                    style={{ width: `${downloadProgress.percent}%` }}
                  />
                </div>
                <div className="updater-progress-text">
                  {downloadProgress.total > 0
                    ? t("updater.progress", {
                        downloaded: formatBytes(downloadProgress.downloaded),
                        total: formatBytes(downloadProgress.total),
                        percent: downloadProgress.percent,
                      })
                    : formatBytes(downloadProgress.downloaded)}
                </div>
              </div>
            </div>
          )}

          {status === "installing" && (
            <div className="updater-status-box">
              <RefreshCw size={36} className="updater-spinner" />
              <div style={{ fontWeight: 700 }}>{t("updater.installing")}</div>
            </div>
          )}

          {status === "error" && (
            <div className="updater-status-box">
              <AlertTriangle size={40} style={{ color: "var(--danger)" }} />
              <div style={{ fontWeight: 700, fontSize: "15px" }}>{t("updater.error_title")}</div>
              <div style={{ color: "var(--text-secondary)", fontSize: "12.5px" }}>
                {errorMessage}
              </div>
              <div className="updater-actions">
                <button className="btn-secondary-action" onClick={onClose}>
                  {t("updater.close")}
                </button>
                <button className="btn-primary-action" onClick={() => void performCheck()}>
                  <RefreshCw size={14} />
                  <span>{t("updater.retry")}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
