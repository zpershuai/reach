import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { GATEWAY_VERSION } from "../version.js";
import { MCP_VERSION } from "../mcp/version.js";
import type { createMcpHttpHandler } from "../mcp/http.js";
import type { ConsoleConfig } from "./config.js";
import { ConsoleAuth, ConsoleError } from "./auth.js";
import { ActivityLog, type ActivityFilters } from "./activity.js";
import type { AuditWriter } from "./audit.js";
import { GatewayEvents } from "./events.js";
import { InvalidJsonError, readJsonBody, PayloadTooLargeError, sendJson } from "./http.js";
import { EngineRegistry, RegistryError, deviceKinds, type RegisteredEngine } from "./registry.js";
import type { ConsoleStore } from "./store.js";
import { serveEvents } from "./sse.js";
import type { OAuthServer } from "./oauth.js";
import { ClientAccess, ClientAccessError } from "./client-access.js";

const name = z.string().trim().min(1).max(64).regex(/^[^\x00-\x1f\x7f]+$/);
const override = z.object({ kind: z.enum(deviceKinds), model: z.string().max(64).regex(/^[^\x00-\x1f\x7f]*$/) }).strict();
const enginePatch = z.object({ displayName: name.optional(), deviceOverride: override.nullable().optional() }).strict();
const settingsPatch = z.object({ retentionDays: z.number().int().min(1).max(365).optional(), theme: z.enum(["light", "dark", "system"]).optional(), heartbeatDisplay: z.boolean().optional() }).strict();
const activityQuery = z.object({
  from: z.coerce.number().int().optional(), to: z.coerce.number().int().optional(), engineId: z.string().optional(), clientLabel: z.string().optional(),
  methodClass: z.enum(["read", "write", "exec", "control"]).optional(), outcome: z.enum(["ok", "error", "denied", "not_ok"]).optional(),
  cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).optional(),
});

export function engineView(engine: RegisteredEngine, registry: EngineRegistry, now: number, heartbeatInterval: number): Record<string, unknown> {
  const { tokenDigest: _digest, server: _server, api, retire: _retire, ...registration } = engine;
  const status = api.status();
  return {
    ...registration, session: status, enrollmentStatus: registry.enrollmentStatus(engine.id),
    // A connected Engine stops heartbeating while its session socket is open.
    online: ["ready", "connecting"].includes(String(status.status))
      || engine.lastSeenAt !== null && now - engine.lastSeenAt < heartbeatInterval * 3000,
    effectiveHardware: engine.hardware || engine.deviceOverride ? { ...engine.hardware, ...engine.deviceOverride } : null,
  };
}

export class ConsoleServer {
  constructor(
    private readonly store: ConsoleStore, private readonly config: ConsoleConfig,
    private readonly registry: EngineRegistry, private readonly events: GatewayEvents,
    private readonly audit: AuditWriter, private readonly activity: ActivityLog,
    private readonly auth: ConsoleAuth, private readonly mcp: ReturnType<typeof createMcpHttpHandler>,
    private readonly oauth: OAuthServer,
    private readonly access: ClientAccess,
    private readonly heartbeatInterval: number, private readonly updateEnabled: boolean,
    private readonly now = Date.now,
  ) {}

  private settings(): Record<string, unknown> {
    const result: Record<string, unknown> = { retentionDays: this.config.retentionDays, theme: "system", heartbeatDisplay: true };
    for (const row of this.store.db.prepare("SELECT key,value FROM settings").all()) result[String(row.key)] = JSON.parse(String(row.value));
    return result;
  }

  private engines(): Record<string, unknown>[] {
    return [...this.registry.engines.values()].map(engine => engineView(engine, this.registry, this.now(), this.heartbeatInterval));
  }

  private clients(): Record<string, unknown>[] {
    const active = this.mcp.clients();
    const rows = this.store.db.prepare("SELECT * FROM clients").all();
    for (const client of active) if (!rows.some(row => row.label === client.label && row.type === "mcp-http")) rows.push({ label: client.label, type: "mcp-http", last_seen_at: this.now() });
    return rows.map(row => {
      const counts = this.store.db.prepare(`SELECT count(*) AS calls, coalesce(sum(outcome IN ('error','denied')),0) AS errors
        FROM activity WHERE client_label=? AND client_type=? AND event_type IN ('rpc.finished','rpc.denied') AND ts >= ?`).get(row.label, row.type, this.now() - 86_400_000)!;
      return { label: row.label, type: row.type, verified: false, lastSeenAt: row.last_seen_at,
        activeSessions: row.type === "mcp-http" ? active.find(client => client.label === row.label)?.activeSessions ?? 0 : 0,
        ownedEngines: [...this.registry.engines.values()].filter(engine => {
          const session = engine.api.status() as { status: string; ownerLabel?: string };
          return session.status !== "none" && session.ownerLabel === row.label;
        }).map(engine => engine.id), calls24h: counts.calls, errors24h: counts.errors };
    });
  }

  snapshot(): Record<string, unknown> {
    const now = this.now();
    const clients = this.clients();
    const engines = this.engines();
    const requests = this.store.db.prepare("SELECT count(*) AS n FROM activity WHERE event_type IN ('rpc.finished','rpc.denied') AND ts >= ?").get(now - 60_000)!;
    const errorRate = this.store.db.prepare("SELECT count(*) AS n,coalesce(sum(outcome != 'ok'),0) AS errors FROM activity WHERE event_type IN ('rpc.finished','rpc.denied') AND ts >= ?").get(now - 300_000)!;
    const midnight = new Date(now); midnight.setUTCHours(0, 0, 0, 0);
    const denials = this.store.db.prepare("SELECT count(*) AS n FROM activity WHERE event_type='rpc.denied' AND stage='policy' AND ts >= ?").get(midnight.getTime())!;
    const warnings: string[] = [];
    if (!this.audit.storageHealth || !this.registry.storageHealth || !this.activity.storageHealth) warnings.push(`Audit storage failure: ${this.config.dataDir}`);
    if (!this.config.publicOrigin.startsWith("https:")) warnings.push("Console uses HTTP; configure an HTTPS public origin for public access.");
    if (!this.config.trustedProxies.length) warnings.push("No trusted proxies configured; behind a proxy, per-client rate limiting may share one peer address.");
    return { ts: now, eventId: this.events.replay(0).at(-1)?.id ?? 0, clients, engines, settings: this.settings(), activity: this.activity.query({ limit: 100 }).rows,
      gateway: { version: GATEWAY_VERSION, mcpVersion: MCP_VERSION, publicOrigin: this.config.publicOrigin, updateEnabled: this.updateEnabled, heartbeatInterval: this.heartbeatInterval, warnings },
      kpis: { clients: clients.length, registeredEngines: engines.length, onlineEngines: engines.filter(engine => engine.online).length,
        activeMcpSessions: this.mcp.clients().reduce((sum, client) => sum + client.activeSessions, 0), requestsPerMinute: Number(requests.n),
        errorRate5m: Number(errorRate.n) ? Number(errorRate.errors) / Number(errorRate.n) : 0, policyDenialsToday: Number(denials.n) } };
  }

  async handle(url: URL, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = url.pathname.slice("/api/console/".length);
    if (await this.auth.handle(path, request, response)) return;
    response.setHeader("cache-control", "no-store");
    try {
      const mutation = !["GET", "HEAD"].includes(request.method ?? "");
      const recent = request.method === "DELETE" && path.startsWith("engines/")
        || request.method === "POST" && (path === "engines" || /^engines\/[^/]+\/rotate$/.test(path) || /^clients\/[^/]+\/disconnect$/.test(path)) || request.method === "DELETE" && path.startsWith("oauth/")
        || mutation && (path === "access-clients" || path.startsWith("access-clients/"));
      this.auth.require(request, mutation, recent);
      const method = request.method;
      if (method === "GET" && path === "access-clients") { sendJson(response, 200, { clients: this.access.list() }); return; }
      if (method === "POST" && path === "access-clients") {
        const body = z.object({ name, expiresAt: z.number().int(), permissions: z.unknown().optional() }).strict().parse(await readJsonBody(request));
        const result = this.access.create(body.name, body.expiresAt, body.permissions);
        this.auth.action(`client.create:${result.client.id}`);
        sendJson(response, 201, result); return;
      }
      const accessRoute = /^access-clients\/([^/]+)(?:\/(rotate|policy|review-global))?$/.exec(path);
      if (accessRoute) {
        const id = decodeURIComponent(accessRoute[1]);
        const action = accessRoute[2];
        if (method === "GET" && !action) { sendJson(response, 200, { client: this.access.get(id) }); return; }
        if (method === "DELETE" && !action) {
          this.access.revoke(id); this.auth.action(`client.revoke:${id}`);
          sendJson(response, 200, { revoked: id }); return;
        }
        if (method === "POST" && action === "rotate") {
          const body = z.object({ expiresAt: z.number().int() }).strict().parse(await readJsonBody(request));
          const result = this.access.rotate(id, body.expiresAt);
          this.auth.action(`client.rotate:${id}`); sendJson(response, 200, result); return;
        }
        if (method === "PATCH" && action === "policy") {
          const body = z.object({ permissions: z.unknown() }).strict().parse(await readJsonBody(request));
          const client = this.access.setPolicy(id, body.permissions);
          this.auth.action(`client.policy:${id}`); sendJson(response, 200, { client }); return;
        }
        if (method === "POST" && action === "review-global") {
          z.object({ confirm: z.literal(true) }).strict().parse(await readJsonBody(request));
          const client = this.access.reviewLegacy(id);
          this.auth.action(`client.review-global:${id}`); sendJson(response, 200, { client }); return;
        }
      }
      if (method === "GET" && path === "events") { serveEvents(this.events, request, response, () => Boolean(this.auth.session(request))); return; }
      if (method === "GET" && path === "snapshot") { sendJson(response, 200, this.snapshot()); return; }
      if (method === "GET" && (path === "activity" || path === "activity/export")) {
        const filters = activityQuery.parse(Object.fromEntries(url.searchParams)) as ActivityFilters;
        if (path === "activity") sendJson(response, 200, this.activity.query(filters));
        else {
          const format = z.enum(["csv", "jsonl"]).parse(url.searchParams.get("format"));
          await this.activity.export(response, format, filters, this.events);
        }
        return;
      }
      if (method === "GET" && path === "engines") { sendJson(response, 200, { engines: this.engines() }); return; }
      if (method === "POST" && path === "engines") {
        const body = z.object({ id: z.string(), displayName: name }).strict().parse(await readJsonBody(request));
        const result = this.registry.add(body.id, body.displayName);
        this.auth.action(`engine.add:${body.id}`);
        sendJson(response, 201, { engine: this.engines().find(engine => engine.id === body.id), token: result.token, publicOrigin: this.config.publicOrigin });
        return;
      }
      const engineRoute = /^engines\/([^/]+)(\/rotate)?$/.exec(path);
      if (engineRoute) {
        const id = decodeURIComponent(engineRoute[1]);
        if (method === "PATCH" && !engineRoute[2]) {
          this.registry.update(id, enginePatch.parse(await readJsonBody(request)));
          this.auth.action(`engine.update:${id}`);
          sendJson(response, 200, { engine: this.engines().find(engine => engine.id === id) }); return;
        }
        if (method === "POST" && engineRoute[2]) {
          const token = this.registry.rotate(id); this.auth.action(`engine.rotate:${id}`); sendJson(response, 200, { token }); return;
        }
        if (method === "DELETE" && !engineRoute[2]) {
          this.registry.remove(id); this.auth.action(`engine.remove:${id}`); sendJson(response, 200, { removed: id }); return;
        }
      }
      if (method === "GET" && path === "clients") { sendJson(response, 200, { clients: this.clients() }); return; }
      const disconnect = /^clients\/([^/]+)\/disconnect$/.exec(path);
      if (method === "POST" && disconnect) {
        const label = decodeURIComponent(disconnect[1]);
        await this.mcp.disconnect(label); this.auth.action(`client.disconnect:${label}`); sendJson(response, 200, { disconnected: label }); return;
      }
      if (method === "GET" && path === "oauth") { sendJson(response, 200, { clients: this.oauth.clients() }); return; }
      const oauthClient = /^oauth\/([^/]+)$/.exec(path);
      if (method === "DELETE" && oauthClient) {
        const id = decodeURIComponent(oauthClient[1]);
        if (!this.oauth.revoke(id)) { sendJson(response, 404, { error: "Unknown OAuth application" }); return; }
        this.auth.action(`oauth.revoke:${id}`); sendJson(response, 200, { revoked: id }); return;
      }
      if (method === "GET" && path === "settings") { sendJson(response, 200, this.settings()); return; }
      if (method === "PATCH" && path === "settings") {
        const settings = settingsPatch.parse(await readJsonBody(request));
        if (settings.retentionDays !== undefined) this.auth.require(request, true, true);
        this.store.transaction(() => {
          const upsert = this.store.db.prepare("INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
          for (const [key, value] of Object.entries(settings)) upsert.run(key, JSON.stringify(value));
        });
        this.auth.action("settings.update"); sendJson(response, 200, this.settings()); return;
      }
      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      if (error instanceof ConsoleError) sendJson(response, error.status, { error: error.message, ...(error.code ? { code: error.code } : {}) });
      else if (error instanceof RegistryError) sendJson(response, error.status, { error: error.message });
      else if (error instanceof ClientAccessError) sendJson(response, error.status, { error: error.message });
      else if (error instanceof PayloadTooLargeError) sendJson(response, 413, { error: "Body exceeds 64 KiB" });
      else if (error instanceof z.ZodError || error instanceof InvalidJsonError || error instanceof URIError || error instanceof Error && error.message.includes("cursor")) sendJson(response, 400, { error: "Invalid console request" });
      else sendJson(response, 500, { error: "Console storage unavailable" });
    }
  }
}
