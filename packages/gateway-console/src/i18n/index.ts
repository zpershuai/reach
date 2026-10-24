import { createInstance } from "i18next";
import { useSyncExternalStore } from "react";
import { en } from "./en";
import { zhCN } from "./zh-CN";

export type Lang = "en" | "zh-CN";
export const languageKey = "reach.console.lang";
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: typeof en };
    strictKeyChecks: true;
  }
}

export function resolveLang(): Lang {
  try {
    const saved = localStorage.getItem(languageKey);
    if (saved === "en" || saved === "zh-CN") return saved;
  } catch {
    /* Storage can be blocked by browser policy. */
  }
  for (const tag of navigator.languages) {
    if (/^zh(?:-|$)/i.test(tag)) return "zh-CN";
    if (/^en(?:-|$)/i.test(tag)) return "en";
  }
  return "en";
}

export const i18n = createInstance();
void i18n.init({
  lng: resolveLang(),
  fallbackLng: "en",
  supportedLngs: ["en", "zh-CN"],
  resources: { en: { translation: en }, "zh-CN": { translation: zhCN } },
  initAsync: false,
  // React escapes text nodes and attributes at the rendering boundary.
  interpolation: { escapeValue: false },
});
function syncDocument(): void {
  const lang = i18n.language as Lang;
  document.documentElement.lang = lang;
  document.title = i18n.t("app.title");
}
i18n.on("languageChanged", syncDocument);
syncDocument();
export function setLang(lang: Lang): void {
  try {
    localStorage.setItem(languageKey, lang);
  } catch {
    /* Optional persistence. */
  }
  document.cookie = `reach_lang=${lang}; Path=/; SameSite=Lax; Max-Age=31536000`;
  void i18n.changeLanguage(lang);
}
const subscribe = (listener: () => void) => {
  i18n.on("languageChanged", listener);
  return () => {
    i18n.off("languageChanged", listener);
  };
};
const snapshot = () => i18n.language as Lang;
export function useT() {
  const lang = useSyncExternalStore(subscribe, snapshot);
  return { t: i18n.getFixedT(lang), lang, setLang };
}
