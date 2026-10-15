import type { Engine, Snapshot } from "./types";
export const engine: Engine = {
  id: "engine-a",
  displayName: "Example device",
  origin: "console",
  createdAt: 1000,
  hardware: {
    kind: "mac-mini",
    model: "Mac mini",
    os: "macOS",
    osVersion: "15",
    arch: "arm64",
  },
  deviceOverride: null,
  effectiveHardware: { kind: "mac-mini", model: "Mac mini" },
  lastSeenAt: 1000,
  engineVersion: "1.0",
  online: true,
  enrollmentStatus: "connected",
  session: {
    status: "ready",
    sessionId: "session-a",
    workspaces: ["default", "scripts"],
    processWorkspaces: ["scripts"],
  },
};
export function snapshot(): Snapshot {
  return structuredClone({
    ts: 1000,
    eventId: 0,
    engines: [engine],
    clients: [
      {
        label: "Test client 1",
        type: "mcp-http",
        verified: false,
        lastSeenAt: 1000,
        activeSessions: 1,
        ownedEngines: ["engine-a"],
        calls24h: 5,
        errors24h: 1,
      },
    ],
    activity: [],
    gateway: {
      version: "1.0",
      mcpVersion: "1.0",
      publicOrigin: "https://gateway.example.com",
      heartbeatInterval: 15,
      updateEnabled: false,
      warnings: [],
    },
    settings: { retentionDays: 30, theme: "system", heartbeatDisplay: true },
    kpis: {
      clients: 1,
      registeredEngines: 1,
      onlineEngines: 1,
      activeMcpSessions: 1,
      requestsPerMinute: 5,
      errorRate5m: 0,
      policyDenialsToday: 1,
    },
  });
}
