import { createContext, useContext, useSyncExternalStore } from "react";
import type { Theme } from "./types";

export interface SessionUser {
  id: number;
  username: string;
  role: "admin" | "user";
  totpEnabled: boolean;
}

const SessionContext = createContext<SessionUser | undefined>(undefined);
export const SessionProvider = SessionContext.Provider;

/**
 * The signed-in account. Outside a provider (isolated component tests) the
 * console behaves as an administrator; the Gateway enforces roles regardless.
 */
export function useSession(): { user?: SessionUser; isAdmin: boolean } {
  const user = useContext(SessionContext);
  return { user, isAdmin: user ? user.role === "admin" : true };
}

/*
 * Theme is a Gateway-wide setting only administrators may change. Read-only
 * accounts keep their own choice in this browser instead.
 */
const themeKey = "reach.console.theme";
const themeListeners = new Set<() => void>();

export function localTheme(): Theme | undefined {
  try {
    const value = localStorage.getItem(themeKey);
    return value === "light" || value === "dark" || value === "system"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

export function setLocalTheme(value: Theme): void {
  try {
    localStorage.setItem(themeKey, value);
  } catch {
    // Blocked storage still applies the theme for this page.
  }
  document.documentElement.dataset.theme = value;
  for (const listener of themeListeners) listener();
}

export function useLocalTheme(): Theme | undefined {
  return useSyncExternalStore(
    (listener) => {
      themeListeners.add(listener);
      return () => themeListeners.delete(listener);
    },
    localTheme,
  );
}
