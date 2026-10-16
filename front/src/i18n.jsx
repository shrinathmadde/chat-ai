import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

// Import the JSON resource files
import en from './i18n/en';
import de from './i18n/de';

const resources = {
  en: { translation: en },
  de: { translation: de },
};

// A deployment can set the interface language ("language" in front.json). It
// then applies from the first visit until the user picks another with the
// flags, instead of the browser's language. The choice is kept under its own
// key: the default detection stores the browser's language on every visit,
// which would otherwise override the setting.
const defaultLanguage = Object.keys(resources).includes(import.meta.env.VITE_DEFAULT_LANGUAGE)
  ? import.meta.env.VITE_DEFAULT_LANGUAGE
  : null;

i18n
  // detect user language
  // learn more: https://github.com/i18next/i18next-browser-languageDetector
  .use(LanguageDetector)
  // pass the i18n instance to react-i18next.
  .use(initReactI18next)
  // init i18next
  // for all options read: https://www.i18next.com/overview/configuration-options
  .init({
    debug: false,
    fallbackLng: defaultLanguage || "en",
    ...(defaultLanguage && {
      detection: {
        order: ["localStorage"],
        lookupLocalStorage: "chat-ai-language",
        caches: ["localStorage"],
      },
    }),
    interpolation: {
      escapeValue: false, // not needed for react as it escapes by default
    },
    resources,
  });

export default i18n;
