import { useSyncExternalStore } from "react";
export function navigate(path: string): void {
  history.pushState(null, "", `/console/${path}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
export function useRoute(): string {
  return useSyncExternalStore(
    (listener) => {
      window.addEventListener("popstate", listener);
      return () => window.removeEventListener("popstate", listener);
    },
    () => location.pathname.replace(/^\/console\/?/, "") || "overview",
  );
}
