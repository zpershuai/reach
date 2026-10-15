import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/console/",
  plugins: [react()],
  // Never inline assets: the Gateway CSP allows fonts only from its own origin.
  build: { outDir: "../reach-rpc/dist/console", emptyOutDir: true, assetsInlineLimit: 0 },
  server: {
    proxy: {
      "/api/console": {
        target: process.env.REACH_DEV_GATEWAY ?? "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    restoreMocks: true,
    clearMocks: true,
  },
});
