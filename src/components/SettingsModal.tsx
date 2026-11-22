import React from "react";
import { useTranslation } from "react-i18next";
import { Settings, Globe, RefreshCw, Info, X } from "lucide-react";
import { setLanguage } from "../i18n";
import "./modals.css";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenAbout: () => void;
  onCheckUpdate: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  onOpenAbout,
  onCheckUpdate,
}) => {
  const { t, i18n } = useTranslation();

  if (!isOpen) return null;

  const currentLang = i18n.language.startsWith("vi") ? "vi" : "en";

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="modal-container" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            <Settings size={18} className="text-violet" />
            <span>{t("settings.title")}</span>
          </div>
          <button className="modal-close-btn" onClick={onClose} aria-label={t("settings.close")}>
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          <div className="settings-section">
            <div className="settings-card">
              <div className="settings-card-info">
                <div className="settings-card-label" style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <Globe size={15} />
                  <span>{t("settings.language_label")}</span>
                </div>
                <div className="settings-card-desc">{t("settings.language_desc")}</div>
              </div>
              <div className="language-selector">
                <button
                  className={`language-tab ${currentLang === "en" ? "active" : ""}`}
                  onClick={() => void setLanguage("en")}
                >
                  {t("settings.en")}
                </button>
                <button
                  className={`language-tab ${currentLang === "vi" ? "active" : ""}`}
                  onClick={() => void setLanguage("vi")}
                >
                  {t("settings.vi")}
                </button>
              </div>
            </div>

            <div className="settings-card">
              <div className="settings-card-info">
                <div className="settings-card-label" style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <RefreshCw size={15} />
                  <span>{t("settings.update_label")}</span>
                </div>
                <div className="settings-card-desc">{t("settings.update_desc")}</div>
              </div>
              <button
                className="btn-secondary-action"
                onClick={() => {
                  onClose();
                  onCheckUpdate();
                }}
              >
                {t("settings.check_updates")}
              </button>
            </div>

            <div className="settings-card">
              <div className="settings-card-info">
                <div className="settings-card-label" style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <Info size={15} />
                  <span>{t("settings.about_label")}</span>
                </div>
                <div className="settings-card-desc">{t("settings.about_desc")}</div>
              </div>
              <button
                className="btn-secondary-action"
                onClick={() => {
                  onClose();
                  onOpenAbout();
                }}
              >
                {t("settings.view_about")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
