import type { HardwareDescriptor } from "./registry.js";
import { deviceKinds } from "./registry.js";
import { boundedMetadata, diagnosticCode, diagnosticRoute } from "../diagnostics.js";

export interface CallerContext {
  type: "controller" | "mcp-http" | "engine" | "console";
  label: string;
  verified: false;
  mcpSessionId?: string;
  /** Server-derived identity; label and clientInfo remain untrusted display metadata. */
  principalId?: string;
}

export type GatewayEventType = "rpc.started" | "rpc.finished" | "rpc.denied" | "session.state" | "engine.heartbeat"
  | "client.connected" | "client.disconnected" | "auth.failed" | "admin.action";

export interface GatewayEventFields {
  engineId?: string;
  caller?: CallerContext;
  requestId?: string;
  sessionId?: string;
  method?: string;
  methodClass?: "read" | "write" | "exec" | "control" | "skill";
  workspace?: string;
  path?: string;
  script?: string;
  processId?: string;
  launchId?: string;
  outcome?: "ok" | "error" | "denied";
  code?: string;
  stage?: "auth" | "policy" | "route";
  latencyMs?: number;
  responseBytes?: number;
  status?: string;
  ownerLabel?: string;
  workspaces?: string[];
  processWorkspaces?: string[];
  engineVersion?: string;
  intervalSeconds?: number;
  hardware?: HardwareDescriptor | null;
  enrollmentStatus?: "awaiting_heartbeat" | "connected";
  reason?: "delete" | "idle" | "shutdown" | "console";
  action?: string;
  count?: number;
}

export interface GatewayEvent extends GatewayEventFields {
  id: number;
  ts: number;
  type: GatewayEventType;
}

export function controllerCaller(value: string | string[] | undefined): CallerContext {
  const label = typeof value === "string" && /^[\x20-\x7e]{1,64}$/.test(value) ? value : "Controller API";
  return { type: "controller", label, verified: false };
}

/** Reconstruct approved event fields so bodies and exception objects cannot enter SSE/audit. */
export function eventMetadata(fields: GatewayEventFields): GatewayEventFields {
  const result: GatewayEventFields = {};
  for (const key of ["engineId", "requestId", "sessionId", "method", "methodClass", "workspace", "path", "script", "processId", "launchId", "outcome", "stage", "status", "ownerLabel", "engineVersion", "enrollmentStatus", "reason", "action"] as const) {
    const value = boundedMetadata(fields[key], key === "path" ? 1024 : 256);
    if (value !== undefined) (result as Record<string, unknown>)[key] = value;
  }
  for (const key of ["latencyMs", "responseBytes", "intervalSeconds", "count"] as const) {
    if (typeof fields[key] === "number" && Number.isFinite(fields[key])) result[key] = fields[key];
  }
  for (const key of ["workspaces", "processWorkspaces"] as const) {
    if (Array.isArray(fields[key])) result[key] = fields[key].slice(0, 128).map(value => boundedMetadata(value) ?? "");
  }
  if (fields.code !== undefined) result.code = diagnosticCode(fields.code);
  if (fields.caller) result.caller = {
    type: fields.caller.type, label: boundedMetadata(fields.caller.label, 64) ?? "Client", verified: false,
    ...(fields.caller.principalId ? { principalId: boundedMetadata(fields.caller.principalId, 128) } : {}),
    ...(fields.caller.mcpSessionId ? { mcpSessionId: boundedMetadata(fields.caller.mcpSessionId, 128) } : {}),
  };
  if (fields.hardware === null) result.hardware = null;
  else if (fields.hardware) result.hardware = {
    kind: deviceKinds.includes(fields.hardware.kind) ? fields.hardware.kind : "unknown", model: boundedMetadata(fields.hardware.model, 64) ?? "",
    os: boundedMetadata(fields.hardware.os, 64) ?? "", osVersion: boundedMetadata(fields.hardware.osVersion, 64) ?? "", arch: boundedMetadata(fields.hardware.arch, 64) ?? "",
  };
  return result;
}

export class GatewayEvents {
  private nextId = 1;
  private readonly buffer: GatewayEvent[] = [];
  private readonly listeners = new Set<(event: GatewayEvent) => void>();
  private readonly authFailures = new Map<string, { last: number; count: number }>();

  constructor(private readonly now = Date.now, private readonly logger: (message: string) => void = console.error) {}

  emit(type: GatewayEventType, fields: GatewayEventFields = {}): GatewayEvent {
    const event: GatewayEvent = Object.freeze({ ...eventMetadata(fields), id: this.nextId++, ts: this.now(), type });
    this.buffer.push(event);
    if (this.buffer.length > 2000) this.buffer.shift();
    for (const listener of this.listeners) {
      try { listener(event); }
      catch {
        try { this.logger("Console event listener failed"); } catch { /* Observability cannot fail the data plane. */ }
      }
    }
    return event;
  }

  subscribe(listener: (event: GatewayEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  replay(after: number): GatewayEvent[] {
    return this.buffer.filter(event => event.id > after);
  }

  authFailed(path: string, peer: string): void {
    path = diagnosticRoute(path);
    const key = `${path}\0${peer}`;
    const prior = this.authFailures.get(key);
    if (prior && this.now() - prior.last < 60_000) { prior.count++; return; }
    const count = (prior?.count ?? 0) + 1;
    if (this.authFailures.size >= 10_000) this.authFailures.delete(this.authFailures.keys().next().value!);
    this.authFailures.set(key, { last: this.now(), count: 0 });
    this.emit("auth.failed", { path, stage: "auth", outcome: "denied", count });
  }
}
