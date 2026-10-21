import { canonicalizeInvocation } from "../canonical.js";
import type { GatewayEvent, GatewayEventFields, GatewayEvents } from "./events.js";
import { eventMetadata } from "./events.js";
import type { ConsoleStore } from "./store.js";

export function methodClass(method: string): NonNullable<GatewayEventFields["methodClass"]> {
  if (["fs.write", "fs.edit"].includes(method)) return "write";
  if (method === "process.run") return "exec";
  if (method.startsWith("fs.") || ["process.status", "process.logs", "process.list"].includes(method)) return "read";
  if (method.startsWith("skill.")) return "skill";
  return "control";
}

export function auditInvocation(method: string, params: Record<string, unknown>): GatewayEventFields {
  const leaf = canonicalizeInvocation(method, params);
  const fields: GatewayEventFields = { method: leaf.method, methodClass: methodClass(leaf.method) };
  let keys: readonly ("workspace" | "path" | "script" | "processId" | "launchId")[] = [];
  if (leaf.method.startsWith("fs.")) keys = ["workspace", "path"];
  else if (leaf.method.startsWith("process.")) keys = ["workspace", "script", "processId", "launchId"];
  for (const key of keys) {
    if (typeof leaf.params[key] === "string") fields[key] = leaf.params[key];
  }
  return eventMetadata(fields);
}

const persistedEvents = new Set(["rpc.finished", "rpc.denied", "auth.failed", "client.connected", "client.disconnected", "admin.action"]);
const columns = {
  ts: "ts", eventType: "event_type", requestId: "request_id", engineId: "engine_id", clientLabel: "client_label", clientType: "client_type", principalId: "principal_id",
  method: "method", methodClass: "method_class", workspace: "workspace", path: "path", script: "script", processId: "process_id", launchId: "launch_id",
  outcome: "outcome", code: "code", stage: "stage", latencyMs: "latency_ms", responseBytes: "response_bytes",
} as const;

interface ClientObservation { label: string; type: string; ts: number }

export class AuditWriter {
  private readonly queue: AuditRecord[] = [];
  private readonly clients = new Map<string, ClientObservation>();
  private readonly timer: ReturnType<typeof setInterval>;
  private scheduled: ReturnType<typeof setImmediate> | undefined;
  private readonly unsubscribe: () => void;
  private readonly write: (rows: AuditRecord[], clients: ClientObservation[]) => void;
  storageHealth = true;
  dropped = 0;

  constructor(
    store: ConsoleStore,
    events: GatewayEvents,
    private readonly logger: (message: string) => void = console.error,
    write?: (rows: AuditRecord[]) => void,
  ) {
    const keys = Object.keys(columns) as Array<keyof typeof columns>;
    const insert = store.db.prepare(`INSERT INTO activity (${keys.map(key => columns[key]).join(",")}) VALUES (${keys.map(() => "?").join(",")})`);
    const client = store.db.prepare(`INSERT INTO clients(label,type,last_seen_at) VALUES (?,?,?)
      ON CONFLICT(label,type) DO UPDATE SET last_seen_at=max(last_seen_at,excluded.last_seen_at)`);
    this.write = write ?? ((rows, observations) => store.transaction(() => {
      for (const row of rows) {
        insert.run(...keys.map(key => row[key] ?? null));

      }
      for (const observation of observations) client.run(observation.label, observation.type, observation.ts);
    }));
    this.unsubscribe = events.subscribe(event => {
      const caller = event.caller;
      if (caller && ["controller", "mcp-http"].includes(caller.type)) {
        const key = `${caller.type}\0${caller.label}`;
        if (this.clients.size === 10_000 && !this.clients.has(key)) this.clients.delete(this.clients.keys().next().value!);
        this.clients.set(key, { label: caller.label, type: caller.type, ts: event.ts });
        if (this.clients.size >= 200) this.schedule();
      }
      if (!persistedEvents.has(event.type)) return;
      if (this.queue.length === 10_000) { this.queue.shift(); this.dropped++; }
      this.queue.push(auditRecord(event));
      if (this.queue.length >= 200) this.schedule();
    });
    this.timer = setInterval(() => this.flush(), 250);
    this.timer.unref();
  }

  get pending(): number { return this.queue.length; }

  flush(): void {
    if (!this.queue.length && !this.clients.size) return;
    const rows = this.queue.splice(0, 200);
    const observations: ClientObservation[] = [];
    for (const [key, observation] of this.clients) {
      this.clients.delete(key);
      observations.push(observation);
      if (observations.length === 200) break;
    }
    try { this.write(rows, observations); }
    catch {
      this.storageHealth = false;
      this.dropped += rows.length;
      try { this.logger("Console audit storage write failed"); } catch { /* Preserve data-plane results. */ }
    }
    if (this.queue.length >= 200 || this.clients.size >= 200) this.schedule();
  }

  private schedule(): void {
    this.scheduled ??= setImmediate(() => { this.scheduled = undefined; this.flush(); });
  }

  close(): void {
    this.unsubscribe();
    clearInterval(this.timer);
    if (this.scheduled) clearImmediate(this.scheduled);
    while (this.queue.length || this.clients.size) this.flush();
    if (this.scheduled) clearImmediate(this.scheduled);
  }
}

export interface AuditRecord {
  ts: number;
  eventType: string;
  requestId?: string;
  engineId?: string;
  clientLabel?: string;
  clientType?: string;
  principalId?: string;
  method?: string;
  methodClass?: string;
  workspace?: string;
  path?: string;
  script?: string;
  processId?: string;
  launchId?: string;
  outcome?: string;
  code?: string;
  stage?: string;
  latencyMs?: number;
  responseBytes?: number;
}

/** Rebuild the record explicitly so extra event or request fields never persist. */
export function auditRecord(event: GatewayEvent): AuditRecord {
  event = { ...eventMetadata(event), id: event.id, ts: event.ts, type: event.type };
  return {
    ts: event.ts, eventType: event.type, requestId: event.requestId, engineId: event.engineId,
    clientLabel: event.caller?.label, clientType: event.caller?.type, principalId: event.caller?.principalId,
    method: event.method ?? event.action, methodClass: event.methodClass,
    workspace: event.workspace, path: event.path, script: event.script, processId: event.processId, launchId: event.launchId,
    outcome: event.outcome, code: event.code, stage: event.stage, latencyMs: event.latencyMs, responseBytes: event.responseBytes,
  };
}
