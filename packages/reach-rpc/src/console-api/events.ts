import type { HardwareDescriptor } from "./registry.js";

export interface CallerContext {
  type: "controller" | "mcp-http" | "engine" | "console";
  label: string;
  verified: false;
  mcpSessionId?: string;
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

export class GatewayEvents {
  private nextId = 1;
  private readonly buffer: GatewayEvent[] = [];
  private readonly listeners = new Set<(event: GatewayEvent) => void>();
  private readonly authFailures = new Map<string, { last: number; count: number }>();

  constructor(private readonly now = Date.now, private readonly logger: (message: string) => void = console.error) {}

  emit(type: GatewayEventType, fields: GatewayEventFields = {}): GatewayEvent {
    const event: GatewayEvent = Object.freeze({ ...fields, id: this.nextId++, ts: this.now(), type });
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
    const key = `${path}\0${peer}`;
    const prior = this.authFailures.get(key);
    if (prior && this.now() - prior.last < 60_000) { prior.count++; return; }
    const count = (prior?.count ?? 0) + 1;
    if (this.authFailures.size >= 10_000) this.authFailures.delete(this.authFailures.keys().next().value!);
    this.authFailures.set(key, { last: this.now(), count: 0 });
    this.emit("auth.failed", { path, stage: "auth", outcome: "denied", count });
  }
}
