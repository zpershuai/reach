import { useSyncExternalStore } from "react";

function subscribe(listener: () => void): () => void {
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
}
export function navigate(
  path: string,
  { replace = false }: { replace?: boolean } = {},
): void {
  history[replace ? "replaceState" : "pushState"](null, "", `/console/${path}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
export function useRoute(): string {
  return useSyncExternalStore(
    subscribe,
    () => location.pathname.replace(/^\/console\/?/, "") || "overview",
  );
}
export function useSearch(): string {
  return useSyncExternalStore(subscribe, () => location.search);
}
