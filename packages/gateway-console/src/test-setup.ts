import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { resetServerClock } from "./clock";
import { resetOverlayStack } from "./ui";
afterEach(() => {
  cleanup();
  resetOverlayStack();
  resetServerClock();
});
// Node 25+ defines its own Web Storage globals, which are undefined without
// --localstorage-file and shadow jsdom's. Use jsdom's storage instead.
const dom = (globalThis as { jsdom?: { window: Window } }).jsdom;
for (const name of ["localStorage", "sessionStorage"] as const)
  if (dom)
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: dom.window[name],
    });
Object.defineProperty(window, "matchMedia", {
  value: vi.fn(() => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })),
});
globalThis.ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};

import { languageKey, setLang } from "./i18n";
beforeEach(() => {
  setLang("en");
  localStorage.removeItem(languageKey);
  document.cookie = "reach_lang=; Path=/; Max-Age=0";
});
