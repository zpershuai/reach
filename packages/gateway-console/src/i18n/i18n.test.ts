import { afterEach, expect, it, vi } from "vitest";
import { i18n, languageKey, resolveLang, setLang } from "./index";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.removeItem(languageKey);
  setLang("en");
});
it("detects the first supported browser preference", () => {
  localStorage.removeItem(languageKey);
  vi.spyOn(navigator, "languages", "get").mockReturnValue([
    "fr",
    "zh-CN",
    "en",
  ]);
  expect(resolveLang()).toBe("zh-CN");
});
it("falls back to English for unsupported browser languages", () => {
  localStorage.removeItem(languageKey);
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["fr-FR", "de"]);
  expect(resolveLang()).toBe("en");
});
it("restores the saved choice ahead of browser detection and synchronizes the document", () => {
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["en"]);
  setLang("zh-CN");
  expect(resolveLang()).toBe("zh-CN");
  expect(localStorage.getItem(languageKey)).toBe("zh-CN");
  expect(document.documentElement.lang).toBe("zh-CN");
  expect(document.title).toBe("Reach 网关");
  expect(document.cookie).toContain("reach_lang=zh-CN");
});
it("detects and switches languages when storage is blocked", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["zh-TW"]);
  expect(resolveLang()).toBe("zh-CN");
  expect(() => setLang("zh-CN")).not.toThrow();
  expect(i18n.language).toBe("zh-CN");
  setLang("en");
  expect(i18n.language).toBe("en");
});

it("does not persist browser detection, and follows a changed browser preference on the next visit", async () => {
  const languages = vi.spyOn(navigator, "languages", "get").mockReturnValue(["zh-CN"]);
  vi.resetModules();
  const firstVisit = await import("./index");
  expect(firstVisit.i18n.language).toBe("zh-CN");
  expect(document.documentElement.lang).toBe("zh-CN");
  expect(localStorage.getItem(languageKey)).toBeNull();
  expect(document.cookie).not.toContain("reach_lang=");
  languages.mockReturnValue(["en"]);
  vi.resetModules();
  const nextVisit = await import("./index");
  expect(nextVisit.i18n.language).toBe("en");
  expect(localStorage.getItem(languageKey)).toBeNull();
  expect(document.cookie).not.toContain("reach_lang=");
  // Selecting the already detected language is still an explicit preference.
  nextVisit.setLang("en");
  expect(localStorage.getItem(languageKey)).toBe("en");
  expect(document.cookie).toContain("reach_lang=en");
});
