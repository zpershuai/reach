export * from "./gateway-policy.js";
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
import {
  CLOSURE_AGENT_REQUESTED,
  CLOSURE_DISCONNECTED,
  CLOSURE_SESSION_COMPLETE,
  MESSAGE_CLOSED,
  MESSAGE_READY,
  parseSessionClosed,
  parseSessionReady,
} from "./index.js";

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
}

class PayloadTooLargeError extends Error {}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  if (Number(request.headers["content-length"] ?? 0) > MAX_HTTP_BODY_BYTES) throw new PayloadTooLargeError();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_HTTP_BODY_BYTES) throw new PayloadTooLargeError();
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid JSON");
  }
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function rejectUpgrade(socket: Duplex): void {
  socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  socket.destroy();
}

function isoDate(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

export function createGateway(options: GatewayOptions = {}): Server {
  const authentication = options.authentication;
  if (options.engines !== undefined && !authentication) throw new Error("Multiple Engines require Gateway authentication");
  const engines = authentication ? [authentication, ...(options.engines ?? [])] : [];
  if (new Set(engines.map((engine) => engine.engineId)).size !== engines.length
    || new Set(engines.map((engine) => engine.engineToken)).size !== engines.length) {
    throw new Error("Engine ids and Engine tokens must be unique");
  }
  const gateways = new Map<string, ReturnType<typeof createEngineGateway>>();
  const defaultId = authentication?.engineId ?? "local-engine";
  if (!authentication) gateways.set(defaultId, createEngineGateway(options));
  for (const engine of engines) {
    gateways.set(engine.engineId, createEngineGateway({
      ...options,
      authentication: { ...engine, controllerToken: authentication!.controllerToken },
    }, options.engines === undefined ? SESSION_ENDPOINT_PATH : `${SESSION_ENDPOINT_PATH}?engineId=${encodeURIComponent(engine.engineId)}`));
  }
  const gateway = createServer();
  const mcp = createMcpHttpHandler(new Map([...gateways].map(([id, engine]) => [id, engine.api])), authentication?.controllerToken, options.mcp, () => {
    const address = gateway.address();
    return typeof address === "object" && address !== null && ["127.0.0.1", "::1"].includes(address.address);
  });
  const selectGateway = (request: IncomingMessage): Server | undefined => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const selected = url.searchParams.get("engineId");
    if (url.pathname === "/heartbeat" && authentication) {
      const provided = Buffer.from(request.headers.authorization ?? "");
      const engine = engines.find(({ engineToken }) => {
        const required = Buffer.from(`Bearer ${engineToken}`);
        return provided.length === required.length && timingSafeEqual(provided, required);
      });
      if (!engine || (selected !== null && selected !== engine.engineId)) return undefined;
      return gateways.get(engine.engineId)?.server;
    }
    return gateways.get(selected ?? defaultId)?.server;
  };
  gateway.on("request", (request: IncomingMessage, response: ServerResponse) => {
    if (new URL(request.url ?? "/", "http://localhost").pathname === "/mcp") {
      void mcp.handle(request, response);
      return;
    }
    const target = selectGateway(request);
    if (!target) {
      const heartbeat = new URL(request.url ?? "/", "http://localhost").pathname === "/heartbeat";
      sendJson(response, heartbeat ? 401 : 404, { error: "unknown or unauthorized engine" });
      return;
    }
    request.url = new URL(request.url ?? "/", "http://localhost").pathname;
    target.emit("request", request, response);
  });
  gateway.on("upgrade", (request, socket, head) => {
    const target = selectGateway(request);
    if (!target) return rejectUpgrade(socket);
    target.emit("upgrade", request, socket, head);
  });
  gateway.on("close", () => {
    mcp.shutdown();
    for (const target of gateways.values()) target.server.emit("close");
  });
  return gateway;
}

/** One isolated state machine per Engine, owned by the listening Gateway. */
function createEngineGateway(options: GatewayOptions, sessionEndpoint = SESSION_ENDPOINT_PATH): { server: Server; api: EngineApi } {
  const authentication = options.authentication;
  if (authentication && (authentication.controllerToken.length < 32 || authentication.engineToken.length < 32
    || authentication.controllerToken === authentication.engineToken || !authentication.engineId.trim())) {
    throw new Error("Gateway authentication requires distinct tokens of at least 32 characters and an engine id");
  }
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
  const state = new EngineSessionState(now, logger, sessionLeaseMs, sessionEndpoint);
  const forwarder = new SessionRpcForwarder(state, grants, now, sessionRpcTimeoutMs);
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
      const expected = request.url === "/heartbeat" ? authentication.engineToken : authentication.controllerToken;
      const provided = Buffer.from(request.headers.authorization ?? "");
      const required = Buffer.from(`Bearer ${expected}`);
      if (provided.length !== required.length || !timingSafeEqual(provided, required)) {
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
      const result = wanted ? state.openSession() : state.requestClose();
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
      const result = state.openSession(intent.sessionId);
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
        const result = await forwarder.executeRpc(await readJsonBody(request), receivedAt);
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

      let message: { type?: unknown; requestId?: unknown; error?: { code?: unknown } };
      try {
        message = JSON.parse(text.toString()) as typeof message;
      } catch {
        webSocket.send(JSON.stringify({ type: "error", error: { code: "INVALID_PARAMS" } }));
        return;
      }

      if (message.type === "response" || message.type === "error") {
        const requestId = typeof message.requestId === "string" ? message.requestId : undefined;
        if (!requestId) return;
        const pending = forwarder.pendingRpcs.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        forwarder.pendingRpcs.delete(requestId);
        if (message.type === "error" && (message.error?.code === "DEADLINE_EXCEEDED" || message.error?.code === "SESSION_CLOSED")) {
          forwarder.noteTimedOutRequest(requestId);
        }
        pending.resolve(message as Record<string, unknown>);
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
          state.engineVersion = ready.engineVersion;
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
        logger(`Reach session closed by engine: ${reason}`);
        if (state.leaseTimer) clearTimeout(state.leaseTimer);
        return;
      }

      if (message.type === "job.done") {
        // Legacy short-job completion: translate to a session close.
        session.closed = true;
        state.sessionWanted = false;
        state.lastClosureReason = CLOSURE_SESSION_COMPLETE;
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
    open: (sessionId) => {
      const result = state.openSession(sessionId);
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
    rpc: (body) => forwarder.executeRpc(body, now()),
  };
  return { server: gateway, api };
}

async function readOptionalJsonBody(request: IncomingMessage): Promise<unknown> {
  const length = Number(request.headers["content-length"] ?? 0);
  if (length === 0 && !request.headers["transfer-encoding"]) return {};
  return readJsonBody(request);
}
