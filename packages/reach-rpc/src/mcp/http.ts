import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EngineApi } from "./in-process.js";
import { closeOwnedClients, RemoteMcpServer, type OwnedClients } from "./remote-server.js";
import type { GatewayEvents } from "../console-api/events.js";

const VERSIONS = ["2025-03-26", "2025-06-18"];
const MAX_BODY = 64 * 1024;

export interface McpHttpOptions {
  events?: GatewayEvents;
  allowedOrigins?: readonly string[];
  sessionIdleMs?: number;
  responseTimeoutMs?: number;
  maxSessions?: number;
  maxQueue?: number;
  /** Accepts OAuth access tokens alongside the Controller token. */
  oauth?: { verify(authorization: string | undefined): { id: string } | undefined; challenge(invalidToken: boolean): string };
}

interface HttpSession {
  id: string;
  /** Who created the session: "controller", "oauth:<client id>" or "loopback"; later requests must match. */
  principal: string;
  /** Shared Engine ownership for OAuth clients, which open a new MCP session for each tool call. */
  pool?: OwnerPool;
  retireReason?: "delete" | "idle" | "shutdown" | "console";
  version: string;
  server: RemoteMcpServer;
  messages: Record<string, unknown>[];
  tail: Promise<unknown>;
  queued: number;
  reading: number;
  cleanupTask?: Promise<void>;
  lastUsed: number;
}

interface OwnerPool {
  principal: string;
  /** Latest ingress label, so console disconnects also end ownership kept through idle grace. */
  label: string;
  clients: OwnedClients;
  sessions: number;
  timer?: ReturnType<typeof setTimeout>;
  closing?: Promise<void>;
}

class HttpError extends Error {
  public constructor(public readonly status: number, message: string, public readonly code = -32600) { super(message); }
}

function json(response: ServerResponse, status: number, body?: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  if (body === undefined) { response.writeHead(status); response.end(); return; }
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  response.end(text);
}

function rpcError(code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: null, error: { code, message } };
}

function isRequest(value: unknown): value is Record<string, unknown> & { method: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return request.jsonrpc === "2.0" && typeof request.method === "string"
    && (request.id === undefined || typeof request.id === "string" || typeof request.id === "number")
    && (request.params === undefined || (typeof request.params === "object" && request.params !== null && !Array.isArray(request.params)));
}

function readBody(request: IncomingMessage, deadline: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => fail(new HttpError(408, "MCP request body timed out")), Math.max(1, deadline - Date.now()));

    function detach(): void {
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onError);
    }

    function fail(error: HttpError): void {
      detach();
      // Drain without retaining the body, so chunked overflow can receive 413.
      request.resume();
      reject(error);
    }

    function onData(chunk: Buffer): void {
      size += chunk.length;
      if (size > MAX_BODY) { fail(new HttpError(413, "MCP body exceeds 64 KiB")); return; }
      chunks.push(chunk);
    }

    function onEnd(): void {
      detach();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new HttpError(400, "Invalid JSON", -32700)); }
    }

    function onError(): void {
      fail(new HttpError(400, "MCP request body interrupted"));
    }

    if (Number(request.headers["content-length"] ?? 0) > MAX_BODY) { fail(new HttpError(413, "MCP body exceeds 64 KiB")); return; }
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onError);
  });
}

function bounded<T>(work: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HttpError(408, "MCP response budget exceeded; re-read before repeating a write")), Math.max(1, deadline - Date.now()));
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export function createMcpHttpHandler(engines: ReadonlyMap<string, EngineApi>, controllerToken?: string, options: McpHttpOptions = {}, isLoopback: () => boolean = () => false): {
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  shutdown(): void;
  disconnect(label: string): Promise<void>;
  clients(): Array<{ label: string; activeSessions: number }>;
} {
  const idleMs = options.sessionIdleMs ?? 300_000;
  const budgetMs = options.responseTimeoutMs ?? 25_000;
  const maxSessions = options.maxSessions ?? 128;
  const maxQueue = options.maxQueue ?? 16;
  for (const value of [idleMs, budgetMs, maxSessions, maxQueue]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("MCP limits must be positive safe integers");
  }
  const sessions = new Map<string, HttpSession>();
  const retired = new Set<HttpSession>();
  const pools = new Map<string, OwnerPool>();
  let stopped = false;

  function attachPool(principal: string, label: string): OwnerPool {
    let pool = pools.get(principal);
    if (!pool) { pool = { principal, label, clients: new Map(), sessions: 0 }; pools.set(principal, pool); }
    pool.label = label;
    if (pool.timer) { clearTimeout(pool.timer); pool.timer = undefined; }
    pool.sessions++;
    return pool;
  }

  /** Closes a pool's Engine sessions once no MCP session has used it for the idle TTL. */
  function closePool(pool: OwnerPool): Promise<void> {
    pool.timer = undefined;
    pool.closing ??= closeOwnedClients(pool.clients, Date.now() + budgetMs).then(() => {
      if (!pool.sessions && !pool.clients.size && pools.get(pool.principal) === pool) pools.delete(pool.principal);
    }, () => {
      // Failed cleanup stays owned and is retried, as for retired sessions.
      if (!pool.sessions && !pool.timer) pool.timer = setTimeout(() => void closePool(pool), Math.min(idleMs, 5000));
      pool.timer?.unref();
    }).finally(() => { pool.closing = undefined; });
    return pool.closing;
  }

  /** Idle expiry keeps ownership for one more TTL; ChatGPT starts a fresh MCP session for later calls. */
  function releasePool(pool: OwnerPool, graceful: boolean): Promise<void> {
    pool.sessions--;
    if (pool.sessions > 0) return Promise.resolve();
    if (stopped || !graceful) return closePool(pool);
    pool.timer = setTimeout(() => void closePool(pool), idleMs);
    pool.timer.unref();
    return Promise.resolve();
  }

  function enqueue<T>(session: HttpSession, work: () => Promise<T>): Promise<T> {
    session.queued++;
    const result = session.tail.then(work).finally(() => { session.queued--; session.lastUsed = Date.now(); });
    session.tail = result.catch(() => undefined);
    return result;
  }

  async function cleanup(session: HttpSession, deadline: number): Promise<void> {
    session.server.deadlineAt = deadline;
    if (session.pool) {
      const pool = session.pool;
      session.pool = undefined;
      await releasePool(pool, session.retireReason === "idle");
    } else await session.server.shutdown();
    retired.delete(session);
  }

  function scheduleCleanup(session: HttpSession, deadline: number): Promise<void> {
    if (session.cleanupTask) return session.cleanupTask;
    const task = enqueue(session, () => cleanup(session, deadline));
    session.cleanupTask = task;
    void task.finally(() => { session.cleanupTask = undefined; }).catch(() => undefined);
    return task;
  }

  function retire(session: HttpSession, deadline = Date.now() + budgetMs, reason: "delete" | "idle" | "shutdown" | "console" = "idle"): Promise<void> {
    if (sessions.has(session.id)) options.events?.emit("client.disconnected", { caller: session.server.caller, reason });
    sessions.delete(session.id);
    session.retireReason ??= reason;
    retired.add(session);
    return scheduleCleanup(session, deadline);
  }

  function requireActive(session: HttpSession): void {
    if (sessions.get(session.id) !== session) throw new HttpError(404, "Unknown or expired MCP session");
  }

  const sweep = setInterval(() => {
    for (const session of sessions.values()) {
      if (!session.queued && !session.reading && Date.now() - session.lastUsed >= idleMs) {
        void retire(session).catch(() => undefined);
      }
    }
    for (const session of retired) {
      if (!session.queued) void scheduleCleanup(session, Date.now() + budgetMs).catch(() => undefined);
    }
  }, Math.max(1, Math.min(1000, Math.floor(idleMs / 2))));
  sweep.unref();

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const deadline = Date.now() + budgetMs;
    let readingSession: HttpSession | undefined;

    function releaseReadPin(): void {
      if (!readingSession) return;
      readingSession.reading--;
      readingSession.lastUsed = Date.now();
      readingSession = undefined;
    }

    try {
      if (stopped) throw new HttpError(503, "Gateway is shutting down");
      const authorization = request.headers.authorization;
      const actual = Buffer.from(authorization ?? "");
      const expected = controllerToken ? Buffer.from(`Bearer ${controllerToken}`) : undefined;
      const controller = expected !== undefined && actual.length === expected.length && timingSafeEqual(actual, expected);
      const oauthClient = controller ? undefined : options.oauth?.verify(authorization);
      if (!controller && !oauthClient && (controllerToken || !isLoopback())) {
        // The challenge lets OAuth clients such as ChatGPT discover the authorization server.
        if (options.oauth) response.setHeader("www-authenticate", options.oauth.challenge(authorization !== undefined));
        throw new HttpError(401, controllerToken ? "unauthorized" : "MCP requires authentication on non-loopback listeners");
      }
      // Refreshed OAuth tokens keep the client id, so a session survives token rotation but not another client.
      const principal = controller ? "controller" : oauthClient ? `oauth:${oauthClient.id}` : "loopback";
      const origin = request.headers.origin;
      if (origin !== undefined && !options.allowedOrigins?.includes(origin)) throw new HttpError(403, "Origin is not allowed");
      if (!["POST", "GET", "DELETE"].includes(request.method ?? "")) { response.setHeader("allow", "POST, DELETE"); json(response, 405); return; }
      const sessionId = request.headers["mcp-session-id"];
      let session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      // Another principal's session is reported as unknown so its existence is not revealed.
      if (session && session.principal !== principal) session = undefined;
      if (session && !session.queued && !session.reading && Date.now() - session.lastUsed >= idleMs) {
        void retire(session).catch(() => undefined);
        session = undefined;
      }
      if (sessionId !== undefined && !session) throw new HttpError(404, "Unknown or expired MCP session");
      const version = request.headers["mcp-protocol-version"];
      if (version !== undefined && (typeof version !== "string" || !VERSIONS.includes(version) || (session && version !== session.version))) throw new HttpError(400, "Unsupported MCP-Protocol-Version");
      if (request.method === "GET") { response.setHeader("allow", "POST, DELETE"); json(response, 405); return; }
      if (request.method === "DELETE") {
        if (!session) throw new HttpError(400, "Mcp-Session-Id is required");
        await bounded(retire(session, deadline, "delete"), deadline);
        json(response, 200);
        return;
      }
      if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") throw new HttpError(415, "Content-Type must be application/json");
      const accept = request.headers.accept ?? "";
      const accepted = accept.split(",").map((value) => value.split(";")[0].trim());
      if (!accepted.includes("application/json") || !accepted.includes("text/event-stream")) throw new HttpError(406, "Accept must include application/json and text/event-stream");
      if (session) {
        if (session.reading + session.queued >= maxQueue) throw new HttpError(429, "MCP session queue is full");
        session.reading++;
        readingSession = session;
      }
      const body = await readBody(request, deadline);
      if (stopped) throw new HttpError(503, "Gateway is shutting down");
      if (session) requireActive(session);
      // No await until enqueue increments queued: idle sweeping cannot interleave
      // with this synchronous handoff. releaseReadPin also refreshes lastUsed.
      releaseReadPin();
      const batch = Array.isArray(body);
      const messages: unknown[] = batch ? body : [body];
      if (!messages.length || messages.length > 64 || !messages.every(isRequest)) { json(response, 400, rpcError(-32600, "Invalid Request")); return; }
      const requests = messages as Array<Record<string, unknown> & { method: string }>;
      if (requests.some((message) => message.method.startsWith("notifications/") !== (message.id === undefined))) {
        json(response, 400, rpcError(-32600, "Requests require an id; notifications must omit it"));
        return;
      }
      if (!session) {
        const init = requests[0];
        if (batch || init.method !== "initialize" || init.id === undefined) throw new HttpError(400, "Initialize first; Mcp-Session-Id is required for later requests");
        const params = init.params as Record<string, unknown> | undefined;
        const client = params?.clientInfo as Record<string, unknown> | undefined;
        if (typeof params?.protocolVersion !== "string" || !params.capabilities || typeof params.capabilities !== "object" || Array.isArray(params.capabilities)
          || !client || typeof client.name !== "string" || typeof client.version !== "string") throw new HttpError(400, "Invalid initialize parameters");
        if (sessions.size + retired.size >= maxSessions) throw new HttpError(503, "MCP session limit reached");
        const negotiated = VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS.at(-1)!;
        const output: Record<string, unknown>[] = [];
        const id = randomUUID();
        const clientLabel = `${client.name} ${client.version}`.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 64).trim() || "MCP client";
        const pool = oauthClient ? attachPool(principal, clientLabel) : undefined;
        session = { id, principal, pool, version: negotiated,
          server: new RemoteMcpServer(engines, (message) => output.push(message), negotiated, clientLabel, id, pool?.clients), messages: output,
          tail: Promise.resolve(), queued: 0, reading: 0, lastUsed: Date.now() };
        sessions.set(session.id, session);
        options.events?.emit("client.connected", { caller: session.server.caller });
        response.setHeader("mcp-session-id", session.id);
      } else {
        if (requests.some((message) => message.method === "initialize")) throw new HttpError(400, "MCP session is already initialized");
        if (batch && session.version !== "2025-03-26") throw new HttpError(400, "Batching requires MCP 2025-03-26");
      }
      if (session.reading + session.queued >= maxQueue) throw new HttpError(429, "MCP session queue is full");
      const current = session;
      const replies = await bounded(enqueue(current, async () => {
        requireActive(current);
        current.messages.length = 0;
        current.server.deadlineAt = deadline - Math.min(100, budgetMs / 10);
        for (const message of requests) {
          requireActive(current);
          if (Date.now() >= current.server.deadlineAt) throw new HttpError(408, "MCP response budget exceeded before dispatch");
          if (!current.server.initialized && message.method !== "notifications/initialized" && message.method !== "initialize" && message.method !== "ping") throw new HttpError(400, "Send notifications/initialized before using tools");
          await current.server.receive(message);
        }
        return current.messages.filter((message) => "id" in message).slice();
      }), deadline);
      if (!replies.length) json(response, 202);
      else json(response, 200, batch ? replies : replies[0]);
    } catch (cause) {
      const status = cause instanceof HttpError ? cause.status : 503;
      if (status === 408 || status === 413) response.setHeader("connection", "close");
      json(response, status, rpcError(cause instanceof HttpError ? cause.code : -32603, cause instanceof Error ? cause.message : "MCP request failed"));
    } finally {
      releaseReadPin();
    }
  }

  return {
    handle,
    disconnect: async label => {
      await Promise.all([...sessions.values()].filter(session => session.server.caller.label === label)
        .map(session => retire(session, Date.now() + budgetMs, "console")));
      await Promise.all([...pools.values()].filter(pool => pool.label === label && !pool.sessions)
        .map(pool => { if (pool.timer) clearTimeout(pool.timer); return closePool(pool); }));
    },
    clients: () => {
      const counts = new Map<string, number>();
      for (const session of sessions.values()) counts.set(session.server.caller.label, (counts.get(session.server.caller.label) ?? 0) + 1);
      return [...counts].map(([label, activeSessions]) => ({ label, activeSessions }));
    },
    shutdown: () => {
      stopped = true;
      clearInterval(sweep);
      for (const session of sessions.values()) void retire(session, Date.now() + budgetMs, "shutdown").catch(() => undefined);
      for (const session of retired) void scheduleCleanup(session, Date.now() + budgetMs).catch(() => undefined);
      for (const pool of pools.values()) if (!pool.sessions) { if (pool.timer) clearTimeout(pool.timer); void closePool(pool); }
    },
  };
}
