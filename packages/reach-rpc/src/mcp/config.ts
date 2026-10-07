import { readFileSync } from "node:fs";

export interface DeviceConfig {
  id: string;
  gatewayUrl: string;
  controllerToken?: string;
  /** Explicit Gateway Engine identity; omit for a legacy default Engine. */
  engineId?: string;
}

export type ToolMode = "dynamic" | "static";

export interface ConnectorConfig {
  devices: readonly DeviceConfig[];
  toolMode: ToolMode;
  readyTimeoutMs: number;
  readyPollMs: number;
  renewSkewMs: number;
  requestTimeoutMs: number;
}

const DEFAULT_DEVICE: DeviceConfig = {
  id: "local-engine",
  gatewayUrl: "http://127.0.0.1:8787",
};

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function normalizeDevice(value: unknown): DeviceConfig {
  if (typeof value !== "object" || value === null) throw new Error("REACH_MCP_DEVICES entries must be objects");
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string" || !candidate.id.trim()) throw new Error("device id must be a non-empty string");
  if (typeof candidate.gatewayUrl !== "string") throw new Error("device gatewayUrl must be a string");
  let gatewayUrl: URL;
  try {
    gatewayUrl = new URL(candidate.gatewayUrl);
  } catch {
    throw new Error(`device ${candidate.id} has an invalid gatewayUrl`);
  }
  if (gatewayUrl.protocol !== "http:" && gatewayUrl.protocol !== "https:") {
    throw new Error(`device ${candidate.id} gatewayUrl must use HTTP(S)`);
  }
  gatewayUrl.pathname = gatewayUrl.pathname.replace(/\/$/, "");
  const controllerToken = candidate.controllerToken;
  if (candidate.engineId !== undefined && (typeof candidate.engineId !== "string" || !candidate.engineId.trim())) {
    throw new Error("device engineId must be a non-empty string");
  }
  if (controllerToken !== undefined && (typeof controllerToken !== "string" || controllerToken.length < 32)) {
    throw new Error("device controllerToken must contain at least 32 characters");
  }
  return {
    id: candidate.id.trim(),
    gatewayUrl: gatewayUrl.toString().replace(/\/$/, ""),
    ...(controllerToken === undefined ? {} : { controllerToken }),
    ...(candidate.engineId === undefined ? {} : { engineId: (candidate.engineId as string).trim() }),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConnectorConfig {
  if (env.REACH_MCP_DEVICES && env.REACH_MCP_DEVICES_FILE) {
    throw new Error("Use only one of REACH_MCP_DEVICES and REACH_MCP_DEVICES_FILE");
  }
  const rawDevices = env.REACH_MCP_DEVICES_FILE ? readFileSync(env.REACH_MCP_DEVICES_FILE, "utf8") : env.REACH_MCP_DEVICES;
  const devices = rawDevices
    ? (() => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawDevices);
      } catch {
        throw new Error("REACH_MCP_DEVICES must be a JSON array");
      }
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("REACH_MCP_DEVICES must contain at least one device");
      return parsed.map(normalizeDevice);
    })()
    : [DEFAULT_DEVICE];
  if (new Set(devices.map((device) => device.id)).size !== devices.length) {
    throw new Error("REACH_MCP_DEVICES device ids must be unique");
  }
  const requestedMode = env.REACH_MCP_TOOL_MODE ?? "dynamic";
  if (requestedMode !== "dynamic" && requestedMode !== "static") {
    throw new Error("REACH_MCP_TOOL_MODE must be dynamic or static");
  }
  return {
    devices,
    toolMode: requestedMode,
    // The idle Engine polls every 120s; allow that poll plus connection setup.
    readyTimeoutMs: positiveInteger(env.REACH_MCP_READY_TIMEOUT_MS, 150_000, "REACH_MCP_READY_TIMEOUT_MS"),
    readyPollMs: positiveInteger(env.REACH_MCP_READY_POLL_MS, 200, "REACH_MCP_READY_POLL_MS"),
    renewSkewMs: positiveInteger(env.REACH_MCP_RENEW_SKEW_MS, 60_000, "REACH_MCP_RENEW_SKEW_MS"),
    requestTimeoutMs: positiveInteger(env.REACH_MCP_REQUEST_TIMEOUT_MS, 35_000, "REACH_MCP_REQUEST_TIMEOUT_MS"),
  };
}
