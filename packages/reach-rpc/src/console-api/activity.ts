import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { SQLInputValue } from "node:sqlite";
import type { AuditRecord } from "./audit.js";
import type { GatewayEvents } from "./events.js";
import type { ConsoleStore } from "./store.js";

export interface ActivityFilters {
  from?: number;
  to?: number;
  engineId?: string;
  clientLabel?: string;
  methodClass?: "read" | "write" | "exec" | "control";
  outcome?: "ok" | "error" | "denied" | "not_ok";
  cursor?: string;
  limit?: number;
  excludeAuthFailed?: "1" | "true";
}

export interface ActivityRow extends AuditRecord { id: number }

const selectColumns = `id, ts, event_type AS eventType, request_id AS requestId, engine_id AS engineId,
  client_label AS clientLabel, client_type AS clientType, principal_id AS principalId, method, method_class AS methodClass,
  workspace, path, script, process_id AS processId, launch_id AS launchId, outcome, code, stage,
  latency_ms AS latencyMs, response_bytes AS responseBytes`;
const exportColumns: Array<keyof ActivityRow> = ["id", "ts", "eventType", "requestId", "engineId", "clientLabel", "clientType", "principalId", "method", "methodClass", "workspace", "path", "script", "processId", "launchId", "outcome", "code", "stage", "latencyMs", "responseBytes"];

export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export class ActivityLog {
  private readonly pruneTimer: ReturnType<typeof setInterval>;
  storageHealth = true;

  constructor(
    private readonly store: ConsoleStore,
    private readonly retentionDays: () => number,
    private readonly now = Date.now,
    private readonly logger: (message: string) => void = console.error,
  ) {
    const pruneSafely = (): void => {
      try { this.prune(); }
      catch {
        this.storageHealth = false;
        try { this.logger("Console audit retention prune failed"); } catch { /* Keep forwarding available. */ }
      }
    };
    pruneSafely();
    this.pruneTimer = setInterval(pruneSafely, 24 * 60 * 60 * 1000);
    this.pruneTimer.unref();
  }

  query(filters: ActivityFilters = {}): { rows: ActivityRow[]; cursor: string | null } {
    const limit = filters.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("Activity limit must be between 1 and 200");
    const clauses: string[] = [];
    const values: SQLInputValue[] = [];
    if (filters.excludeAuthFailed) clauses.push("event_type <> 'auth.failed'");
    for (const [key, column] of [["from", "ts >="], ["to", "ts <="]] as const) {
      const value = filters[key];
      if (value !== undefined) {
        if (!Number.isSafeInteger(value)) throw new Error("Invalid activity time");
        clauses.push(`${column} ?`); values.push(value);
      }
    }
    for (const [key, column] of [["engineId", "engine_id"], ["clientLabel", "client_label"], ["methodClass", "method_class"]] as const) {
      if (filters[key] !== undefined) { clauses.push(`${column} = ?`); values.push(filters[key]!); }
    }
    if (filters.outcome === "not_ok") clauses.push("outcome IN ('error','denied')");
    else if (filters.outcome !== undefined) { clauses.push("outcome = ?"); values.push(filters.outcome); }
    if (filters.cursor) {
      let cursor: unknown;
      try { cursor = JSON.parse(Buffer.from(filters.cursor, "base64url").toString()); }
      catch { throw new Error("Invalid activity cursor"); }
      if (!Array.isArray(cursor) || cursor.length !== 2 || !cursor.every(Number.isSafeInteger)) throw new Error("Invalid activity cursor");
      clauses.push("(ts < ? OR (ts = ? AND id < ?))");
      values.push(cursor[0], cursor[0], cursor[1]);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.store.db.prepare(`SELECT ${selectColumns} FROM activity ${where} ORDER BY ts DESC, id DESC LIMIT ?`).all(...values, limit + 1) as unknown as ActivityRow[];
    const more = rows.length > limit;
    if (more) rows.pop();
    const last = rows.at(-1);
    return { rows, cursor: more && last ? Buffer.from(JSON.stringify([last.ts, last.id])).toString("base64url") : null };
  }

  async export(response: ServerResponse, format: "csv" | "jsonl", filters: ActivityFilters, events: GatewayEvents): Promise<void> {
    // Validate the query before committing HTTP headers or recording an export.
    this.query({ ...filters, cursor: undefined, limit: 1 });
    events.emit("admin.action", { caller: { type: "console", label: "Administrator", verified: false }, action: `activity.export.${format}`, outcome: "ok" });
    const date = new Date(this.now()).toISOString().slice(0, 10);
    response.writeHead(200, {
      "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson",
      "content-disposition": `attachment; filename="reach-activity-${date}.${format}"`,
      "cache-control": "no-store",
    });
    await pipeline(Readable.from(this.exportLines(format, filters)), response);
  }

  private *exportLines(format: "csv" | "jsonl", filters: ActivityFilters): Generator<string> {
    if (format === "csv") yield `${exportColumns.join(",")}\r\n`;
    let cursor: string | null = null;
    do {
      const page = this.query({ ...filters, cursor: cursor ?? undefined, limit: 200 });
      for (const row of page.rows) {
        yield format === "csv" ? `${exportColumns.map(key => csvCell(row[key])).join(",")}\r\n` : `${JSON.stringify(row)}\n`;
      }
      cursor = page.cursor;
    } while (cursor);
  }

  prune(): number {
    const days = this.retentionDays();
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error("Invalid audit retention");
    return Number(this.store.db.prepare("DELETE FROM activity WHERE ts < ?").run(this.now() - days * 86_400_000).changes);
  }

  close(): void { clearInterval(this.pruneTimer); }
}
