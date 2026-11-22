import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import vi from "./locales/vi.json";

const STORAGE_KEY = "mirrune_language";

const savedLanguage = (() => {
  try {
    return localStorage.getItem(STORAGE_KEY) || "en";
  } catch {
    return "en";
  }
})();

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    vi: { translation: vi },
  },
  lng: savedLanguage,
  fallbackLng: "en",
  interpolation: {
    escapeValue: false,
  },
});

export const setLanguage = async (lng: string): Promise<void> => {
  try {
    localStorage.setItem(STORAGE_KEY, lng);
  } catch {
    // Ignore localStorage failures
  }
  await i18n.changeLanguage(lng);
};

export default i18n;
