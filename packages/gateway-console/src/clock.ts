import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
// Gateway timestamps (heartbeats, activity) are compared against Gateway time,
// so a skewed browser clock does not mark devices offline.
let offset = 0;
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
function tick(): void {
  now = Date.now() + offset;
  listeners.forEach((listener) => listener());
}
/** Aligns the shared clock with the Gateway time carried by a snapshot. */
export function syncServerClock(serverTs: number): void {
  if (!Number.isFinite(serverTs)) return;
  offset = serverTs - Date.now();
  tick();
}
export function resetServerClock(): void {
  offset = 0;
  now = Date.now();
}
function visibility(): void {
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
  if (document.visibilityState !== "hidden") {
    tick();
    timer = setInterval(tick, 10_000);
  }
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    document.addEventListener("visibilitychange", visibility);
    visibility();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      document.removeEventListener("visibilitychange", visibility);
    }
  };
}
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now);
}
