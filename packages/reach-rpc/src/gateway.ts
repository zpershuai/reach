import { PayloadTooLargeError, readJsonBody, sendJson } from "./console-api/http.js";
export * from "./gateway-policy.js";
import { GatewayUpdater, updateAdmissionPaused, type UpdateConfig } from "./gateway-update.js";
import { DEFAULT_HEARTBEAT_INTERVAL_SECONDS, SESSION_WANTED_HEARTBEAT_INTERVAL_SECONDS, SESSION_TOKEN_TTL_MS, MAX_HTTP_BODY_BYTES, MAX_WEBSOCKET_TEXT_BYTES, SESSION_LEASE_MS, SESSION_IDLE_MS, SESSION_RPC_TIMEOUT_MS, SESSION_CONNECTING_MS, SESSION_ENDPOINT_PATH } from "./gateway-policy.js";
import { EngineSessionState } from "./gateway-state.js";
import { SessionRpcForwarder } from "./gateway-forwarder.js";
import { processGrantSchema } from "./process.js";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { z } from "zod";
import { GrantStore, normalizeWorkspacePath } from "./grants.js";
import { GATEWAY_VERSION } from "./version.js";
export { normalizeWorkspacePath } from "./grants.js";
import { WebSocket, WebSocketServer } from "ws";
import { createMcpHttpHandler, type McpHttpOptions } from "./mcp/http.js";
import type { EngineApi, EngineResult } from "./mcp/in-process.js";
import { ConsoleStore } from "./console-api/store.js";
import type { ConsoleConfig } from "./console-api/config.js";
import { EngineRegistry, type EngineRuntime } from "./console-api/registry.js";
import { controllerCaller, GatewayEvents, type CallerContext } from "./console-api/events.js";
import { AuditWriter } from "./console-api/audit.js";
import { ActivityLog } from "./console-api/activity.js";
import { ConsoleAuth } from "./console-api/auth.js";
import { ConsoleServer } from "./console-api/server.js";
import { OAuthServer } from "./console-api/oauth.js";
import { securityHeaders, serveConsole } from "./console-api/static.js";
import { fileURLToPath } from "node:url";
import {
  CLOSURE_AGENT_REQUESTED,
  CLOSURE_DISCONNECTED,
  CLOSURE_SESSION_COMPLETE,
  MESSAGE_CLOSED,
  MESSAGE_READY,
  parseSessionClosed,
  parseSessionReady,
  sessionReadySchema,
  sessionClosedSchema,
  requestEnvelopeSchema,
} from "./index.js";

const engineMessageSchema = z.discriminatedUnion("type", [
  sessionReadySchema,
  sessionClosedSchema,
  requestEnvelopeSchema,
  z.object({ type: z.literal("response"), requestId: z.string().min(1), result: z.unknown() }).passthrough(),
  z.object({ type: z.literal("error"), requestId: z.string().min(1), error: z.object({ code: z.string().min(1) }).passthrough() }).passthrough(),
  z.object({ type: z.literal("job.done") }),
]);

function requestUrl(request: IncomingMessage): URL | undefined {
  try {
    return new URL(request.url ?? "/", "http://localhost");
  } catch {
    return undefined;
  }
}

const heartbeatRequestSchema = z.object({
  device: z.object({ engineVersion: z.string().min(1).optional() }).passthrough(),
});

const sessionWantedRequestSchema = z.object({
  wanted: z.boolean(),
});

const sessionOpenRequestSchema = z.object({
  engineId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
});

const grantRequestSchema = z.object({
  workspace: z.string().min(1),
  path: z.string().min(1),
  methods: z.array(z.enum(["fs.write", "fs.edit"])).min(1),
});

const sessionControlSchema = z.object({ sessionId: z.string().min(1).optional() });

export interface GatewayOptions {
  console?: ConsoleConfig;
  events?: GatewayEvents;
  consoleAssetsDir?: string;
  logger?: (message: string) => void;
  mcp?: McpHttpOptions;
  now?: () => number;
  sessionDurationMs?: number;
  sessionIdleMs?: number;
  sessionRpcTimeoutMs?: number;
  sessionConnectingMs?: number;
  heartbeatIntervalSeconds?: number;
  authentication?: { controllerToken: string; engineToken: string; engineId: string };
  /** Additional Engines sharing the controller token; legacy requests target authentication.engineId. */
  engines?: readonly { engineId: string; engineToken: string }[];
  update?: UpdateConfig;
  updateFetch?: typeof fetch;
}

function rejectUpgrade(socket: Duplex, status: "400 Bad Request" | "401 Unauthorized" = "401 Unauthorized"): void {
  socket.end("HTTP/1.1 " + status + "\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", () => socket.destroy());
}

function isoDate(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

export interface GatewayServer extends Server { readonly registry: EngineRegistry; readonly events?: GatewayEvents; readonly audit?: AuditWriter }

export function createGateway(options: GatewayOptions = {}): GatewayServer {
  const authentication = options.authentication;
  if (options.engines !== undefined && !authentication) throw new Error("Multiple Engines require Gateway authentication");
  const engines = authentication ? [authentication, ...(options.engines ?? [])] : [];
  if (new Set(engines.map((engine) => engine.engineId)).size !== engines.length
    || new Set(engines.map((engine) => engine.engineToken)).size !== engines.length) {
    throw new Error("Engine ids and Engine tokens must be unique");
  }
  for (const engine of engines) {
    if (authentication!.controllerToken.length < 32 || engine.engineToken.length < 32
      || authentication!.controllerToken === engine.engineToken || !engine.engineId.trim()) {
      throw new Error("Gateway authentication requires distinct tokens of at least 32 characters and an engine id");
    }
  }
  const defaultId = authentication?.engineId ?? "local-engine";
  const events = options.events ?? (options.console ? new GatewayEvents(options.now, options.logger) : undefined);
  let store: ConsoleStore | undefined;
  if (options.console) {
    try {
      store = new ConsoleStore(options.console.dataDir);
    } catch (error) {
      throw new Error(`Cannot open console data directory ${options.console.dataDir}`, { cause: error });
    }
  }
  const registry = new EngineRegistry((registration, verifyEngineToken) => createEngineGateway({
    ...options,
    events,
    authentication: authentication ? { controllerToken: authentication.controllerToken, engineId: registration.id } : undefined,
  }, verifyEngineToken,
  registration.id === defaultId && options.engines === undefined ? SESSION_ENDPOINT_PATH : `${SESSION_ENDPOINT_PATH}?engineId=${encodeURIComponent(registration.id)}`,
  (version, intervalSeconds, hardware) => {
    registry.heartbeat(registration.id, version, hardware);
    events?.emit("engine.heartbeat", {
      engineId: registration.id, engineVersion: version, intervalSeconds,
      caller: { type: "engine", label: registration.id, verified: false }, enrollmentStatus: registry.enrollmentStatus(registration.id),
      hardware: registry.engines.get(registration.id)?.hardware,
    });
  }), store, Boolean(authentication), options.now, options.logger);
  const gateways = registry.engines;
  if (!authentication) registry.seed(defaultId, undefined);
  for (const engine of engines) {
    registry.seed(engine.engineId, engine.engineToken);
  }
  registry.retainSeeds(new Set(authentication ? engines.map((engine) => engine.engineId) : [defaultId]));
  const audit = store && events ? new AuditWriter(store, events, options.logger) : undefined;
  const activity = store && options.console ? new ActivityLog(store, () => {
    const setting = store.db.prepare("SELECT value FROM settings WHERE key='retentionDays'").get();
    return setting ? Number(setting.value) : options.console!.retentionDays;
  }, options.now, options.logger) : undefined;
  const auth = store && options.console && events ? new ConsoleAuth(store, options.console, events, options.now, options.logger) : undefined;
  const gateway = Object.assign(createServer(), { registry, events, audit });
  const oauth = store && options.console && auth ? new OAuthServer(store, options.console, auth, options.now) : undefined;
  const mcp = createMcpHttpHandler(registry.apis, authentication?.controllerToken, { ...options.mcp, events, oauth: oauth ?? options.mcp?.oauth }, () => {
    const address = gateway.address();
    return typeof address === "object" && address !== null && ["127.0.0.1", "::1"].includes(address.address);
  });
  const consoleServer = store && options.console && events && audit && activity && auth
    ? new ConsoleServer(store, options.console, registry, events, audit, activity, auth, mcp, oauth!, options.heartbeatIntervalSeconds ?? DEFAULT_HEARTBEAT_INTERVAL_SECONDS, Boolean(options.update), options.now)
    : undefined;
  const selectGateway = (request: IncomingMessage, url: URL): Server | undefined => {
    const selected = url.searchParams.get("engineId");
    if (url.pathname === "/heartbeat" && authentication) {
      const engine = registry.authenticate(bearerToken(request));
      if (!engine || (selected !== null && selected !== engine.id)) return undefined;
      return engine.server;
    }
    return gateways.get(selected ?? defaultId)?.server;
  };
  gateway.on("request", (request: IncomingMessage, response: ServerResponse) => {
    const rawPath = (request.url ?? "").split("?")[0];
    if (options.console && (rawPath === "/console" || rawPath.startsWith("/console/"))) {
      if (rawPath === "/console") { securityHeaders(response); response.writeHead(302, { location: "/console/" }); response.end(); return; }
      void serveConsole(request, response, options.consoleAssetsDir ?? fileURLToPath(new URL("./console", import.meta.url)));
      return;
    }
    const url = requestUrl(request);
    if (!url) {
      sendJson(response, 400, { error: "invalid request target" });
      return;
    }
    if (url.pathname.startsWith("/api/console/")) {
      // Console authentication records its own failures with the proxy-aware peer address.
      securityHeaders(response);
      if (!consoleServer) { sendJson(response, 404, { error: "not found" }); return; }
      void consoleServer.handle(url, request, response);
      return;
    }
    if (oauth && (url.pathname.startsWith("/.well-known/oauth-") || url.pathname.startsWith("/oauth/"))) {
      // The approval page records its own failures with the proxy-aware peer address.
      void oauth.handle(url, request, response);
      return;
    }
    response.once("finish", () => {
      if (response.statusCode === 401) events?.authFailed(url.pathname, request.socket.remoteAddress ?? "unknown");
    });
    if (url.pathname === "/mcp") {
      void mcp.handle(request, response);
      return;
    }
    const target = selectGateway(request, url);
    if (!target) {
      const heartbeat = url.pathname === "/heartbeat";
      sendJson(response, heartbeat ? 401 : 404, { error: "unknown or unauthorized engine" });
      return;
    }
    request.url = url.pathname;
    target.emit("request", request, response);
  });
  gateway.on("upgrade", (request, socket, head) => {
    const url = requestUrl(request);
    if (!url) {
      rejectUpgrade(socket, "400 Bad Request");
      return;
    }
    const target = selectGateway(request, url);
    if (!target) {
      events?.authFailed(url.pathname, request.socket.remoteAddress ?? "unknown");
      return rejectUpgrade(socket);
    }
    target.emit("upgrade", request, socket, head);
  });
  gateway.on("close", () => {
    mcp.shutdown();
    for (const target of gateways.values()) target.server.emit("close");
    audit?.close();
    activity?.close();
    store?.close();
  });
  if (options.update) {
    const updater = new GatewayUpdater(options.update,
      () => [...gateways.values()].every(engine => engine.api.status().status === "none"),
      options.logger ?? console.log, options.updateFetch, options.now);
    gateway.once("listening", () => updater.start());
    gateway.once("close", () => updater.stop());
  }
  return gateway;
}

/** One isolated state machine per Engine, owned by the listening Gateway. */
function bearerToken(request: IncomingMessage): string {
  const authorization = request.headers.authorization ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
}

type EngineGatewayOptions = Omit<GatewayOptions, "authentication"> & {
  authentication?: { controllerToken: string; engineId: string };
};

function createEngineGateway(options: EngineGatewayOptions, verifyEngineToken: (token: string) => boolean, sessionEndpoint = SESSION_ENDPOINT_PATH, onHeartbeat?: (version: string | undefined, intervalSeconds: number, hardware?: unknown) => void): EngineRuntime {
  const authentication = options.authentication;
  const heartbeatIntervalSeconds = options.heartbeatIntervalSeconds ?? DEFAULT_HEARTBEAT_INTERVAL_SECONDS;
  if (!Number.isInteger(heartbeatIntervalSeconds) || heartbeatIntervalSeconds <= 0) {
    throw new Error("heartbeat interval must be a positive integer");
  }
  const logger = options.logger ?? console.log;
  const now = options.now ?? Date.now;
  const grants = new GrantStore(now);
  const sessionLeaseMs = options.sessionDurationMs ?? SESSION_LEASE_MS;
  const sessionIdleMs = options.sessionIdleMs ?? SESSION_IDLE_MS;
  const sessionRpcTimeoutMs = options.sessionRpcTimeoutMs ?? SESSION_RPC_TIMEOUT_MS;
  const sessionConnectingMs = options.sessionConnectingMs ?? SESSION_CONNECTING_MS;
  const engineId = authentication?.engineId ?? "local-engine";
  const state = new EngineSessionState(now, logger, sessionLeaseMs, sessionEndpoint, status => {
    options.events?.emit("session.state", { engineId, sessionId: status.sessionId, status: status.status, ownerLabel: state.ownerLabel, caller: state.ownerCaller, workspaces: status.workspaces, processWorkspaces: status.processWorkspaces });
  });
  const openSession = (sessionId?: string, caller?: CallerContext): EngineResult => {
    if (updateAdmissionPaused(options.update, now())) return { statusCode: 503, payload: { error: "update in progress" } };
    return state.openSession(sessionId, caller);
  };
  const forwarder = new SessionRpcForwarder(state, grants, now, sessionRpcTimeoutMs, options.events, engineId);
  const sessions = new WebSocketServer({ noServer: true, maxPayload: MAX_WEBSOCKET_TEXT_BYTES });

  const validateControlBinding = async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    try {
      const control = sessionControlSchema.parse(await readOptionalJsonBody(request));
      const currentId = state.liveSession?.sessionId ?? state.pendingSession?.sessionId ?? state.wantedSessionId;
      if (control.sessionId && control.sessionId !== currentId) {
        sendJson(response, 409, { error: "session binding mismatch" });
        return false;
      }
      return true;
    } catch (error) {
      sendJson(response, error instanceof PayloadTooLargeError ? 413 : 400, { error: "invalid session control payload" });
      return false;
    }
  };

  const gateway = createServer(async (request, response) => {
    const receivedAt = now();
    if (request.method === "GET" && request.url === "/healthz") {
      sendJson(response, 200, { status: "ok", protocol: "reach-rpc/1.0", gatewayVersion: GATEWAY_VERSION });
      return;
    }
    if (authentication) {
      const provided = Buffer.from(bearerToken(request));
      const required = Buffer.from(authentication.controllerToken);
      const authorized = request.url === "/heartbeat" ? verifyEngineToken(bearerToken(request))
        : provided.length === required.length && timingSafeEqual(provided, required);
      if (!authorized) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
    }
    if (request.method !== "POST" && request.url !== "/session/status") {
      sendJson(response, 404, { error: "not found" });
      return;
    }

    if (request.url === "/heartbeat") {
      try {
        const heartbeat = heartbeatRequestSchema.parse(await readJsonBody(request));
        if (authentication && heartbeat.device.id !== authentication.engineId) {
          sendJson(response, 403, { error: "engine identity mismatch" });
          return;
        }
        state.engineVersion = heartbeat.device.engineVersion;
        state.lastSeenAt = isoDate(now());
        onHeartbeat?.(heartbeat.device.engineVersion, !state.sessionWanted || state.liveSession ? heartbeatIntervalSeconds : SESSION_WANTED_HEARTBEAT_INTERVAL_SECONDS, heartbeat.device.hardware);
      } catch (error) {
        sendJson(response, error instanceof PayloadTooLargeError ? 413 : 400, { error: "invalid heartbeat payload" });
        return;
      }

      if (!state.sessionWanted || state.liveSession) {
        sendJson(response, 200, { intervalSeconds: heartbeatIntervalSeconds });
        return;
      }

      if (state.pendingSession && state.pendingSession.expiresAt <= now()) state.pendingSession = undefined;
      state.pendingSession ??= {
        token: randomUUID(),
        expiresAt: now() + SESSION_TOKEN_TTL_MS,
        sessionId: state.wantedSessionId ?? randomUUID(),
        leaseExpiresAt: now() + sessionLeaseMs,
      };
      state.notify();
      sendJson(response, 200, {
        intervalSeconds: SESSION_WANTED_HEARTBEAT_INTERVAL_SECONDS,
        endpoint: sessionEndpoint,
        token: state.pendingSession.token,
        sessionId: state.pendingSession.sessionId,
        leaseExpiresAt: isoDate(state.pendingSession.leaseExpiresAt),
      });
      return;
    }

    if (request.url === "/session-wanted") {
      let wanted: boolean;
      try {
        wanted = sessionWantedRequestSchema.parse(await readJsonBody(request)).wanted;
      } catch (error) {
        sendJson(response, error instanceof PayloadTooLargeError ? 413 : 400, { error: "invalid session-wanted payload" });
        return;
      }
      const result = wanted ? openSession(undefined, controllerCaller(request.headers["x-reach-client"])) : state.requestClose();
      sendJson(response, result.statusCode, result.payload);
      return;
    }

    if (request.url === "/session/open") {
      let intent: z.infer<typeof sessionOpenRequestSchema>;
      try {
        intent = sessionOpenRequestSchema.parse(await readOptionalJsonBody(request));
      } catch (error) {
        sendJson(response, error instanceof PayloadTooLargeError ? 413 : 400, { error: "invalid session-open payload" });
        return;
      }
      const result = openSession(intent.sessionId, controllerCaller(request.headers["x-reach-client"]));
      sendJson(response, result.statusCode, { ...result.payload, ...(result.statusCode === 200 ? { sessionId: state.wantedSessionId } : {}) });
      return;
    }

    if (request.url === "/session/renew") {
      if (!await validateControlBinding(request, response)) return;
      const result = state.renewSession();
      sendJson(response, result.statusCode, result.payload);
      return;
    }

    if (request.url === "/session/status") {
      sendJson(response, 200, state.sessionStatus());
      return;
    }

    if (request.url === "/session/close") {
      if (!await validateControlBinding(request, response)) return;
      const result = state.requestClose();
      sendJson(response, result.statusCode, result.payload);
      return;
    }

    if (request.url === "/grants") {
      let body: unknown;
      try { body = await readJsonBody(request); } catch (error) { sendJson(response, error instanceof PayloadTooLargeError ? 413 : 400, { error: "invalid grant payload" }); return; }
      if (typeof body === "object" && body !== null && "kind" in body) {
        const parsed = processGrantSchema.safeParse(body);
        if (!parsed.success || parsed.data.sessionId !== state.liveSession?.sessionId || !state.liveSession?.ready || state.liveSession.closed) { sendJson(response, 400, { error: "invalid process grant scope" }); return; }
        try { sendJson(response, 200, grants.issueProcess(parsed.data)); }
        catch { sendJson(response, 400, { error: "invalid process grant payload" }); }
        return;
      }
      let grantRequest: z.infer<typeof grantRequestSchema>;
      try {
        grantRequest = grantRequestSchema.parse(body);
      } catch (error) {
        sendJson(response, error instanceof PayloadTooLargeError ? 413 : 400, { error: "invalid grant payload" });
        return;
      }

      const normalizedPath = normalizeWorkspacePath(grantRequest.path);
      if (!normalizedPath) {
        sendJson(response, 400, { error: "invalid grant payload" });
        return;
      }

      sendJson(response, 200, grants.issue(grantRequest.workspace, normalizedPath, grantRequest.methods));
      return;
    }

    if (request.url === "/session/rpc") {
      try {
        const result = await forwarder.executeRpc(await readJsonBody(request), receivedAt, controllerCaller(request.headers["x-reach-client"]));
        sendJson(response, result.statusCode, result.payload);
      } catch (error) {
        sendJson(response, error instanceof PayloadTooLargeError ? 413 : 400, { error: "invalid rpc payload" });
      }
      return;
    }

    sendJson(response, 404, { error: "not found" });
  });

  gateway.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://gateway");
    const token = url.searchParams.get("token");
    if (
      request.method !== "GET"
      || url.pathname !== SESSION_ENDPOINT_PATH
      || !state.pendingSession
      || state.pendingSession.expiresAt <= now()
      || token !== state.pendingSession.token
      || state.liveSession
    ) {
      options.events?.authFailed(SESSION_ENDPOINT_PATH, request.socket.remoteAddress ?? "unknown");
      rejectUpgrade(socket);
      return;
    }

    const issued = state.pendingSession;
    // Consume credentials before upgrade, but do NOT mark the session live until
    // the WebSocket handshake succeeds. A failed handshake must not brick the gateway.
    state.pendingSession = undefined;
    state.sessionWanted = false;
    state.wantedSessionId = undefined;

    let upgraded = false;
    const failHandshake = () => {
      if (upgraded || state.liveSession) return;
      state.notify();
      logger("Reach session upgrade failed");
    };
    socket.once("close", failHandshake);
    socket.once("error", failHandshake);

    sessions.handleUpgrade(request, socket, head, (webSocket) => {
      upgraded = true;
      socket.off("close", failHandshake);
      socket.off("error", failHandshake);
      state.liveSession = {
        sessionId: issued.sessionId,
        socket: webSocket,
        ready: false,
        closed: false,
        leaseExpiresAt: issued.leaseExpiresAt,
      };
      state.notify();
      sessions.emit("connection", webSocket, request);
    });
  });

  sessions.on("connection", (webSocket: WebSocket) => {
    const session = state.liveSession;
    if (!session) {
      webSocket.close(1011, "missing session binding");
      return;
    }
    logger("Reach session connected");
    forwarder.seenRequestIds.clear();

    const leakTimer = () => {
      if (state.leaseTimer) clearTimeout(state.leaseTimer);
      state.leaseTimer = setTimeout(state.sessionLimitReached, Math.max(0, session.leaseExpiresAt - now()));
    };
    leakTimer();
    state.resetIdleTimer = () => {
      if (state.idleTimer) clearTimeout(state.idleTimer);
      state.idleTimer = setTimeout(() => {
        if (forwarder.pendingRpcs.size > 0) state.resetIdleTimer?.();
        else state.sessionLimitReached();
      }, sessionIdleMs);
    };
    state.resetIdleTimer();
    if (state.connectingTimer) clearTimeout(state.connectingTimer);
    state.connectingTimer = setTimeout(() => {
      if (!state.liveSession || state.liveSession.socket !== webSocket || state.liveSession.ready || state.liveSession.closed) return;
      state.lastClosureReason = "connecting_timeout";
      state.closeLiveSession(1008, "session connecting timeout");
    }, sessionConnectingMs);

    webSocket.on("error", (error) => {
      logger(`Reach session socket error: ${error instanceof Error ? error.message : String(error)}`);
    });

    webSocket.on("message", (data, isBinary) => {
      state.resetIdleTimer?.();
      const text = Buffer.isBuffer(data)
        ? data
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : Buffer.concat(data);
      if (isBinary || text.length > MAX_WEBSOCKET_TEXT_BYTES) {
        webSocket.close(1009, "message too large");
        return;
      }

      let value: unknown;
      try {
        value = JSON.parse(text.toString()) as unknown;
      } catch {
        webSocket.send(JSON.stringify({ type: "error", error: { code: "INVALID_PARAMS" } }));
        return;
      }

      const parsed = engineMessageSchema.safeParse(value);
      if (!parsed.success || (parsed.data.type === "response" && !Object.hasOwn(parsed.data, "result"))) {
        // Error frames are terminal, including malformed/legacy ones. Replying
        // to them can create a feedback loop with the peer's error handler.
        if (typeof value === "object" && value !== null && "type" in value && value.type === "error") return;
        webSocket.send(JSON.stringify({ type: "error", error: { code: "INVALID_PARAMS" } }));
        return;
      }
      const message = parsed.data;

      if (message.type === "response" || message.type === "error") {
        const requestId = message.requestId;
        const pending = forwarder.pendingRpcs.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        forwarder.pendingRpcs.delete(requestId);
        if (message.type === "error" && (message.error?.code === "DEADLINE_EXCEEDED" || message.error?.code === "SESSION_CLOSED")) {
          forwarder.noteTimedOutRequest(requestId);
        }
        pending.resolve(message as Record<string, unknown>, text.length);
        return;
      }

      // Model B: Engine-originated filesystem requests are not dispatched by Gateway.
      if (message.type === "request") return;

      if (message.type === MESSAGE_READY) {
        try {
          const ready = parseSessionReady(message);
          if (ready.sessionId !== session.sessionId || (authentication && ready.engineId !== authentication.engineId)) {
            webSocket.send(JSON.stringify({ type: "error", error: { code: "INVALID_PARAMS" } }));
            return;
          }
          session.ready = true;
          session.methods = ready.methods;
          session.workspaces = ready.workspaces;
          session.processWorkspaces = ready.processWorkspaces;
          state.engineVersion = ready.engineVersion;
          state.notify();
          if (state.connectingTimer) {
            clearTimeout(state.connectingTimer);
            state.connectingTimer = undefined;
          }
          logger("Reach session ready");
        } catch {
          webSocket.send(JSON.stringify({ type: "error", error: { code: "INVALID_PARAMS" } }));
        }
        return;
      }

      if (message.type === MESSAGE_CLOSED) {
        let reason: string;
        try {
          const closed = parseSessionClosed(message);
          if (closed.sessionId !== session.sessionId) return;
          reason = closed.reason;
        } catch {
          webSocket.send(JSON.stringify({ type: "error", error: { code: "INVALID_PARAMS" } }));
          return;
        }
        // The Engine closes the socket after `session.closed` per protocol; mark
        // the session as draining so new data-plane requests are rejected now.
        session.closed = true;
        state.sessionWanted = false;
        state.lastClosureReason = reason;
        state.notify();
        logger(`Reach session closed by engine: ${reason}`);
        if (state.leaseTimer) clearTimeout(state.leaseTimer);
        return;
      }

      if (message.type === "job.done") {
        // Legacy short-job completion: translate to a session close.
        session.closed = true;
        state.sessionWanted = false;
        state.lastClosureReason = CLOSURE_SESSION_COMPLETE;
        state.notify();
        logger("Reach session job done");
        if (state.leaseTimer) clearTimeout(state.leaseTimer);
        if (state.idleTimer) clearTimeout(state.idleTimer);
        webSocket.close(1000, "job done");
        return;
      }

      // Unknown or malformed control message.
      webSocket.send(JSON.stringify({ type: "error", error: { code: "INVALID_PARAMS" } }));
    });

    webSocket.on("close", (code: number) => {
      if (state.leaseTimer) clearTimeout(state.leaseTimer);
      if (state.idleTimer) clearTimeout(state.idleTimer);
      if (state.connectingTimer) {
        clearTimeout(state.connectingTimer);
        state.connectingTimer = undefined;
      }
      state.resetIdleTimer = undefined;
      if (state.liveSession?.socket === webSocket) {
        // If the Engine never reported a closure reason before the socket ended,
        // classify the observed close: clean after an Agent close, a policy
        // limit, an RPC timeout, or an unexpected disconnect.
        if (state.lastClosureReason === undefined) {
          if (code === 1000) {
            state.lastClosureReason = session.closed ? CLOSURE_AGENT_REQUESTED : CLOSURE_DISCONNECTED;
          } else if (code === 1008) {
            state.lastClosureReason = "policy_limit";
          } else if (code === 1011) {
            state.lastClosureReason = "rpc_timeout";
          } else {
            state.lastClosureReason = CLOSURE_DISCONNECTED;
          }
        }
        state.liveSession = undefined;
        state.notify();
      }
      forwarder.seenRequestIds.clear();
      forwarder.clearPendingRpcs("session closed");
      logger("Reach session closed");
    });
  });

  gateway.on("close", () => {
    if (state.leaseTimer) clearTimeout(state.leaseTimer);
    if (state.idleTimer) clearTimeout(state.idleTimer);
    if (state.connectingTimer) clearTimeout(state.connectingTimer);
    forwarder.clearPendingRpcs("gateway closed");
    state.liveSession?.socket.terminate();
  });
  const binding = (sessionId: string): boolean => sessionId === (state.liveSession?.sessionId ?? state.pendingSession?.sessionId ?? state.wantedSessionId);
  const mismatch = (): EngineResult => ({ statusCode: 409, payload: { error: "session binding mismatch" } });
  const api: EngineApi = {
    status: state.sessionStatus,
    open: (sessionId, caller) => {
      const result = openSession(sessionId, caller);
      return { ...result, payload: { ...result.payload, ...(result.statusCode === 200 ? { sessionId: state.wantedSessionId } : {}) } };
    },
    renew: (sessionId) => binding(sessionId) ? state.renewSession() : mismatch(),
    close: (sessionId) => binding(sessionId) ? state.requestClose() : mismatch(),
    grant: (sessionId, workspace, path, method) => {
      if (!binding(sessionId)) return mismatch();
      const parsed = grantRequestSchema.safeParse({ workspace, path, methods: [method] });
      const normalized = normalizeWorkspacePath(path);
      if (!parsed.success || !normalized) return { statusCode: 400, payload: { error: "invalid grant payload" } };
      return { statusCode: 200, payload: grants.issue(workspace, normalized, [method]) };
    },
    processGrant: (sessionId, scope) => {
      if (!binding(sessionId) || !state.liveSession?.ready || state.liveSession.closed) return mismatch();
      try { return { statusCode: 200, payload: grants.issueProcess({ ...scope, sessionId }) }; }
      catch { return { statusCode: 400, payload: { error: "invalid process grant payload" } }; }
    },
    rpc: (body, caller) => forwarder.executeRpc(body, now(), caller),
  };
  const retire = (): void => {
    state.requestClose();
    grants.clear();
    if (state.leaseTimer) clearTimeout(state.leaseTimer);
    if (state.idleTimer) clearTimeout(state.idleTimer);
    if (state.connectingTimer) clearTimeout(state.connectingTimer);
    forwarder.clearPendingRpcs("engine removed");
    state.closeLiveSession(1000, CLOSURE_AGENT_REQUESTED);
  };
  return { server: gateway, api, retire };
}

async function readOptionalJsonBody(request: IncomingMessage): Promise<unknown> {
  const length = Number(request.headers["content-length"] ?? 0);
  if (length === 0 && !request.headers["transfer-encoding"]) return {};
  return readJsonBody(request);
}
