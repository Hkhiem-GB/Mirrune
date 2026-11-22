import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, X, Cpu, Layers } from "lucide-react";
import "./modals.css";

interface AboutModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const AboutModal: React.FC<AboutModalProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation();
  const [appVersion, setAppVersion] = useState("0.1.1");

  useEffect(() => {
    let mounted = true;
    void getVersion()
      .then((ver) => {
        if (mounted && ver) {
          setAppVersion(ver);
        }
      })
      .catch(() => {
        // Fallback to default
      });
    return () => {
      mounted = false;
    };
  }, []);

  if (!isOpen) return null;

  const handleOpenGithub = async () => {
    try {
      await openUrl("https://github.com/Hkhiem-GB/Mirrune");
    } catch (err) {
      console.error("Failed to open repository URL:", err);
      window.open("https://github.com/Hkhiem-GB/Mirrune", "_blank");
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="modal-container" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            <Layers size={18} />
            <span>{t("about.title")}</span>
          </div>
          <button className="modal-close-btn" onClick={onClose} aria-label={t("about.close")}>
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          <div className="about-hero">
            <img
              src="/logo/svg/primary-logo-transparent.svg"
              alt="Mirrune"
              className="about-logo"
            />
            <div className="about-app-name">{t("about.name")}</div>
            <div className="about-version-badge">
              {t("about.version", { version: appVersion })}
            </div>
            <p className="about-desc">{t("about.description")}</p>

            <button className="btn-secondary-action" onClick={() => void handleOpenGithub()}>
              <ExternalLink size={14} />
              <span>{t("about.open_github")}</span>
            </button>
          </div>

          <div className="about-credits-box">
            <div className="about-credits-title">{t("about.components_title")}</div>
            <div className="about-credits-item">
              <Cpu size={14} />
              <span>{t("about.adb_desc")}</span>
            </div>
            <div className="about-credits-item">
              <Cpu size={14} />
              <span>{t("about.scrcpy_desc")}</span>
            </div>
          </div>

          <div className="about-copyright">{t("about.copyright")}</div>
        </div>
      </div>
    </div>
  );
};
