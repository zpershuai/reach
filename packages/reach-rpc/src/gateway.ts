import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { z } from "zod";
import { canonicalizeInvocation } from "./canonical.js";
import { GrantStore, normalizeWorkspacePath } from "./grants.js";
import { GATEWAY_VERSION } from "./version.js";
export { normalizeWorkspacePath } from "./grants.js";
import { WebSocket, WebSocketServer } from "ws";
import {
  CLOSURE_AGENT_REQUESTED,
  CLOSURE_DISCONNECTED,
  CLOSURE_SESSION_COMPLETE,
  MESSAGE_CLOSE,
  MESSAGE_CLOSED,
  MESSAGE_READY,
  MESSAGE_RENEW,
  ContractError,
  parseFsEditParams,
  parseFsWriteParams,
  parseRequestEnvelope,
  parseSessionClosed,
  parseSessionReady,
  permissionSchema,
} from "./index.js";

export const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 120;
export const SESSION_WANTED_HEARTBEAT_INTERVAL_SECONDS = 5;
export const SESSION_TOKEN_TTL_MS = 30_000;
export const MAX_HTTP_BODY_BYTES = 64 * 1024;
export const MAX_WEBSOCKET_TEXT_BYTES = 1024 * 1024;
/** Length of one issued/renewed session lease. The Engine enforces this locally. */
export const SESSION_LEASE_MS = 5 * 60 * 1000;
/** Gateway-enforced inbound-idle limit while a session is live. */
export const SESSION_IDLE_MS = 5 * 60 * 1000;
/** Client advisory for how often an Agent should renew before its lease expires. */
export const SESSION_RENEW_CADENCE_MS = 60 * 1000;
export const SESSION_RPC_TIMEOUT_MS = 30_000;
export const MAX_PENDING_RPCS = 16;
/** The Gateway-relative WebSocket session endpoint returned on heartbeat. */
export const SESSION_ENDPOINT_PATH = "/session";
/**
 * Upper bound on remembered timed-out request IDs. Prevents unbounded growth
 * while keeping the "a timed-out mutation cannot be retried" guard from being
 * wiped by the session close that the timeout itself triggers.
 */
const MAX_TIMED_OUT_REQUEST_IDS = 4096;
/**
 * Upper bound on request IDs remembered for dedup within one live connection.
 * `seenRequestIds` is keyed to a single WebSocket and survives renewals, so a
 * caller streaming unique IDs across an 8-hour session could otherwise grow it
 * without bound. Oldest entries are evicted once the cap is hit; the Engine's
 * `SessionContext` dedup window is sized identically so the two stay in step.
 */
const MAX_SEEN_REQUEST_IDS = 65_536;

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
  now?: () => number;
  sessionDurationMs?: number;
  sessionIdleMs?: number;
  sessionRpcTimeoutMs?: number;
  heartbeatIntervalSeconds?: number;
  authentication?: { controllerToken: string; engineToken: string; engineId: string };
  /** Additional Engines sharing the controller token; legacy requests target authentication.engineId. */
  engines?: readonly { engineId: string; engineToken: string }[];
}

interface PendingSession {
  token: string;
  /** Token expiry (epoch ms). The token is single-use and short-lived. */
  expiresAt: number;
  sessionId: string;
  /** Absolute lease expiry (epoch ms) for the wanted session. */
  leaseExpiresAt: number;
}

interface LiveSession {
  sessionId: string;
  socket: WebSocket;
  /** True once the Engine has sent a valid `session.ready`. */
  ready: boolean;
  /** True while draining after close/expiry: no new data-plane requests. */
  closed: boolean;
  leaseExpiresAt: number;
}

interface PendingRpc {
  resolve: (payload: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
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

function leafMutation(
  leaf: ReturnType<typeof canonicalizeInvocation>,
): { method: "fs.write" | "fs.edit"; params: { workspace: string; path: string } } | undefined {
  if (leaf.method !== "fs.write" && leaf.method !== "fs.edit") return undefined;
  const parsed = leaf.method === "fs.write" ? parseFsWriteParams(leaf.params) : parseFsEditParams(leaf.params);
  return { method: leaf.method, params: parsed };
}

export function createGateway(options: GatewayOptions = {}): Server {
  if (options.engines === undefined) return createEngineGateway(options);
  const authentication = options.authentication;
  if (!authentication) throw new Error("Multiple Engines require Gateway authentication");
  const engines = [authentication, ...options.engines];
  if (new Set(engines.map((engine) => engine.engineId)).size !== engines.length
    || new Set(engines.map((engine) => engine.engineToken)).size !== engines.length) {
    throw new Error("Engine ids and Engine tokens must be unique");
  }
  const gateways = new Map<string, Server>();
  for (const engine of engines) {
    gateways.set(engine.engineId, createEngineGateway({
      ...options,
      authentication: { ...engine, controllerToken: authentication.controllerToken },
    }, `${SESSION_ENDPOINT_PATH}?engineId=${encodeURIComponent(engine.engineId)}`));
  }
  const selectGateway = (request: IncomingMessage): Server | undefined => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const selected = url.searchParams.get("engineId");
    if (url.pathname === "/heartbeat") {
      // Authenticate before parsing the body. Each Engine handler also checks device.id.
      const provided = Buffer.from(request.headers.authorization ?? "");
      const engine = engines.find(({ engineToken }) => {
        const required = Buffer.from(`Bearer ${engineToken}`);
        return provided.length === required.length && timingSafeEqual(provided, required);
      });
      if (!engine || (selected !== null && selected !== engine.engineId)) return undefined;
      return gateways.get(engine.engineId);
    }
    return gateways.get(selected ?? authentication.engineId);
  };
  const gateway = createServer((request, response) => {
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
    for (const target of gateways.values()) target.emit("close");
  });
  return gateway;
}

/** One isolated state machine per Engine, owned by the listening Gateway. */
function createEngineGateway(options: GatewayOptions, sessionEndpoint = SESSION_ENDPOINT_PATH): Server {
  const authentication = options.authentication;
  if (authentication && (authentication.controllerToken.length < 32 || authentication.engineToken.length < 32
    || authentication.controllerToken === authentication.engineToken || !authentication.engineId.trim())) {
    throw new Error("Gateway authentication requires distinct tokens of at least 32 characters and an engine id");
  }
  const heartbeatIntervalSeconds = options.heartbeatIntervalSeconds ?? DEFAULT_HEARTBEAT_INTERVAL_SECONDS;
  if (!Number.isInteger(heartbeatIntervalSeconds) || heartbeatIntervalSeconds <= 0) {
    throw new Error("heartbeat interval must be a positive integer");
  }
  let sessionWanted = false;
  let wantedSessionId: string | undefined;
  let pendingSession: PendingSession | undefined;
  let liveSession: LiveSession | undefined;
  // Last version advertised by the configured Engine; not an online-status indicator.
  let engineVersion: string | undefined;
  /** Last Engine-reported or observed closure reason, kept for session status. */
  let lastClosureReason: string | undefined;
  let leaseTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let resetIdleTimer: (() => void) | undefined;
  const pendingRpcs = new Map<string, PendingRpc>();
  /** Request IDs already forwarded in the live session (including timed-out ones). */
  const seenRequestIds = new Set<string>();
  /**
   * Request IDs with a timeout or uncertain session-closing outcome. Unlike
   * `seenRequestIds` — which the
   * socket close handler clears — this survives session teardown, so a
   * timed-out mutation (which the Engine may already have applied on disk)
   * cannot be re-executed by retrying the same requestId in a fresh session.
   * Bounded: oldest entries are evicted once `MAX_TIMED_OUT_REQUEST_IDS` is hit.
   */
  const timedOutRequestIds = new Set<string>();
  const noteTimedOutRequest = (requestId: string) => {
    timedOutRequestIds.add(requestId);
    if (timedOutRequestIds.size > MAX_TIMED_OUT_REQUEST_IDS) {
      const oldest = timedOutRequestIds.values().next().value;
      if (oldest !== undefined) timedOutRequestIds.delete(oldest);
    }
  };
  const noteSeenRequest = (requestId: string) => {
    seenRequestIds.add(requestId);
    if (seenRequestIds.size > MAX_SEEN_REQUEST_IDS) {
      const oldest = seenRequestIds.values().next().value;
      if (oldest !== undefined) seenRequestIds.delete(oldest);
    }
  };
  const logger = options.logger ?? console.log;
  const now = options.now ?? Date.now;
  const grants = new GrantStore(now);
  const sessionLeaseMs = options.sessionDurationMs ?? SESSION_LEASE_MS;
  const sessionIdleMs = options.sessionIdleMs ?? SESSION_IDLE_MS;
  const sessionRpcTimeoutMs = options.sessionRpcTimeoutMs ?? SESSION_RPC_TIMEOUT_MS;
  const sessions = new WebSocketServer({ noServer: true, maxPayload: MAX_WEBSOCKET_TEXT_BYTES });

  const clearPendingRpcs = (reason: string) => {
    for (const [requestId, pending] of pendingRpcs) {
      clearTimeout(pending.timer);
      noteTimedOutRequest(requestId);
      pending.reject(new Error(reason));
      pendingRpcs.delete(requestId);
    }
  };

  const closeLiveSession = (code: number, reason: string) => {
    const session = liveSession;
    if (session && (session.socket.readyState === WebSocket.OPEN || session.socket.readyState === WebSocket.CONNECTING)) {
      // Reject new data-plane requests immediately rather than waiting for the close event.
      session.closed = true;
      session.socket.close(code, reason);
    }
  };

  const forwardToEngine = (envelope: Record<string, unknown>, closeOnTimeout: boolean): Promise<Record<string, unknown>> => {
    const session = liveSession;
    if (!session || session.socket.readyState !== WebSocket.OPEN || session.closed) {
      return Promise.reject(new Error("no ready session"));
    }
    const requestId = envelope.requestId;
    if (typeof requestId !== "string" || !requestId) {
      return Promise.reject(new Error("missing requestId"));
    }
    if (pendingRpcs.has(requestId) || seenRequestIds.has(requestId) || timedOutRequestIds.has(requestId)) {
      return Promise.reject(new Error("duplicate requestId"));
    }
    if (pendingRpcs.size >= MAX_PENDING_RPCS) {
      return Promise.reject(new Error("too many pending rpcs"));
    }

    const payload = { ...envelope, sessionId: session.sessionId, type: "request", protocol: "reach-rpc", version: "1.0" };
    noteSeenRequest(requestId);
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRpcs.delete(requestId);
        // Keep timed-out mutation IDs across teardown to prevent re-application.
        noteTimedOutRequest(requestId);
        if (!closeOnTimeout) {
          resolve({ type: "error", requestId, error: { code: "DEADLINE_EXCEEDED" } });
          return;
        }
        reject(new Error("session rpc timeout"));
        // Stop forwarding; a mutation already past its commit boundary may finish.
        closeLiveSession(1011, "session rpc timeout");
      }, Math.max(1, Date.parse(envelope.deadlineAt as string) - now()));
      pendingRpcs.set(requestId, { resolve, reject, timer });
      resetIdleTimer?.();
      try {
        const text = JSON.stringify(payload);
        if (Buffer.byteLength(text) > MAX_WEBSOCKET_TEXT_BYTES) {
          clearTimeout(timer);
          pendingRpcs.delete(requestId);
          seenRequestIds.delete(requestId);
          reject(new Error("message too large"));
          return;
        }
        session.socket.send(text);
      } catch (error) {
        clearTimeout(timer);
        pendingRpcs.delete(requestId);
        seenRequestIds.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  const openSession = (sessionId?: string) => {
    if (liveSession) {
      return { statusCode: 409 as const, payload: { error: "session already active" } };
    }
    if (sessionWanted) {
      if (sessionId && sessionId !== wantedSessionId) {
        return { statusCode: 409 as const, payload: { error: "session binding mismatch" } };
      }
      // Retrying the same intent must preserve its pending token and lease.
      return { statusCode: 200 as const, payload: { wanted: true, status: "wanted" } };
    }
    sessionWanted = true;
    wantedSessionId = sessionId ?? randomUUID();
    pendingSession = undefined;
    lastClosureReason = undefined;
    return { statusCode: 200 as const, payload: { wanted: true, status: "wanted" } };
  };

  const requestClose = () => {
    if (!sessionWanted && !liveSession) {
      return { statusCode: 409 as const, payload: { error: "no session" } };
    }
    const session = liveSession;
    if (session) {
      session.closed = true;
      sessionWanted = false;
      try {
        session.socket.send(JSON.stringify({
          type: MESSAGE_CLOSE,
          sessionId: session.sessionId,
          reason: CLOSURE_AGENT_REQUESTED,
        }));
      } catch {
        lastClosureReason = CLOSURE_DISCONNECTED;
        closeLiveSession(1011, "session close delivery failed");
        return { statusCode: 503 as const, payload: { error: "session close delivery failed" } };
      }
      logger("Reach session close requested");
      return {
        statusCode: 200 as const,
        payload: { sessionId: session.sessionId, status: "closing", reason: CLOSURE_AGENT_REQUESTED },
      };
    }
    sessionWanted = false;
    wantedSessionId = undefined;
    pendingSession = undefined;
    return { statusCode: 200 as const, payload: { status: "none" } };
  };

  const renewSession = () => {
    const session = liveSession;
    if (!session || !session.ready || session.closed || session.socket.readyState !== WebSocket.OPEN) {
      return { statusCode: 409 as const, payload: { error: "no session" } };
    }
    // A renewal always re-bases on the present moment and is capped by the
    // Gateway policy maximum (the lease length). It cannot extend the lease.
    const leaseExpiresAt = now() + sessionLeaseMs;
    session.leaseExpiresAt = leaseExpiresAt;
    try {
      session.socket.send(JSON.stringify({
        type: MESSAGE_RENEW,
        sessionId: session.sessionId,
        leaseExpiresAt: isoDate(leaseExpiresAt),
      }));
    } catch {
      lastClosureReason = CLOSURE_DISCONNECTED;
      closeLiveSession(1011, "session renew delivery failed");
      return { statusCode: 503 as const, payload: { error: "session renew delivery failed" } };
    }
    if (leaseTimer) clearTimeout(leaseTimer);
    leaseTimer = setTimeout(sessionLimitReached, Math.max(0, leaseExpiresAt - now()));
    resetIdleTimer?.();
    logger("Reach session renewed");
    return { statusCode: 200 as const, payload: { sessionId: session.sessionId, leaseExpiresAt: isoDate(leaseExpiresAt) } };
  };

  const sessionLimitReached = () => {
    closeLiveSession(1008, "session limit exceeded");
  };

  const sessionStatus = () => {
    const session = liveSession;
    const status = session
      ? session.closed
        ? "closing"
        : session.ready
          ? "ready"
          : "connecting"
      : sessionWanted
        ? pendingSession
          ? "pending"
          : "wanted"
        : "none";
    return {
      gatewayVersion: GATEWAY_VERSION,
      engineVersion: engineVersion ?? null,
      wanted: sessionWanted,
      status,
      sessionId: session?.sessionId ?? pendingSession?.sessionId ?? wantedSessionId,
      endpoint: pendingSession && !session ? sessionEndpoint : undefined,
      leaseExpiresAt: (session ?? pendingSession) ? isoDate((session ?? pendingSession)!.leaseExpiresAt) : undefined,
      closureReason: lastClosureReason,
    };
  };

  const validateControlBinding = async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    try {
      const control = sessionControlSchema.parse(await readOptionalJsonBody(request));
      const currentId = liveSession?.sessionId ?? pendingSession?.sessionId ?? wantedSessionId;
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
        engineVersion = heartbeat.device.engineVersion;
      } catch (error) {
        sendJson(response, error instanceof PayloadTooLargeError ? 413 : 400, { error: "invalid heartbeat payload" });
        return;
      }

      if (!sessionWanted || liveSession) {
        sendJson(response, 200, { intervalSeconds: heartbeatIntervalSeconds });
        return;
      }

      if (pendingSession && pendingSession.expiresAt <= now()) pendingSession = undefined;
      pendingSession ??= {
        token: randomUUID(),
        expiresAt: now() + SESSION_TOKEN_TTL_MS,
        sessionId: wantedSessionId ?? randomUUID(),
        leaseExpiresAt: now() + sessionLeaseMs,
      };
      sendJson(response, 200, {
        intervalSeconds: SESSION_WANTED_HEARTBEAT_INTERVAL_SECONDS,
        endpoint: sessionEndpoint,
        token: pendingSession.token,
        sessionId: pendingSession.sessionId,
        leaseExpiresAt: isoDate(pendingSession.leaseExpiresAt),
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
      const result = wanted ? openSession() : requestClose();
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
      const result = openSession(intent.sessionId);
      sendJson(response, result.statusCode, { ...result.payload, ...(result.statusCode === 200 ? { sessionId: wantedSessionId } : {}) });
      return;
    }

    if (request.url === "/session/renew") {
      if (!await validateControlBinding(request, response)) return;
      const result = renewSession();
      sendJson(response, result.statusCode, result.payload);
      return;
    }

    if (request.url === "/session/status") {
      sendJson(response, 200, sessionStatus());
      return;
    }

    if (request.url === "/session/close") {
      if (!await validateControlBinding(request, response)) return;
      const result = requestClose();
      sendJson(response, result.statusCode, result.payload);
      return;
    }

    if (request.url === "/grants") {
      let grantRequest: z.infer<typeof grantRequestSchema>;
      try {
        grantRequest = grantRequestSchema.parse(await readJsonBody(request));
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
      const session = liveSession;
      if (!session) {
        sendJson(response, 409, { error: "no live session" });
        return;
      }
      if (!session.ready) {
        sendJson(response, 409, { error: "no ready session" });
        return;
      }
      if (session.closed) {
        sendJson(response, 409, { error: "session closed" });
        return;
      }

      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        sendJson(response, error instanceof PayloadTooLargeError ? 413 : 400, { error: "invalid rpc payload" });
        return;
      }

      let envelope: ReturnType<typeof parseRequestEnvelope>;
      try {
        const candidate = typeof body === "object" && body !== null
          ? { type: "request", protocol: "reach-rpc", version: "1.0", sessionId: session.sessionId, ...(body as Record<string, unknown>) }
          : body;
        envelope = parseRequestEnvelope(candidate);
        if (envelope.sessionId !== session.sessionId) throw new ContractError();
      } catch {
        sendJson(response, 400, { type: "error", error: { code: "INVALID_PARAMS" } });
        return;
      }

      let invocation: ReturnType<typeof canonicalizeInvocation>;
      try {
        invocation = canonicalizeInvocation(envelope.method, envelope.params);
      } catch {
        sendJson(response, 200, { type: "error", requestId: envelope.requestId, error: { code: "INVALID_PARAMS" } });
        return;
      }
      try {
        // Reject nested/pathological `tool.call` before any grant lookup so the
        // response code never depends on grant state (kills the
        // PERMISSION_DENIED-vs-INVALID_PARAMS oracle). Single-level `tool.call`
        // remains visible to `leafMutation` for grant validation.
        const mutation = leafMutation(invocation);
        if (mutation) {
          const permission = permissionSchema.safeParse(envelope.permission);
          if (
            !permission.success
            || !grants.matches(permission.data.grantId, mutation.method, mutation.params.workspace, mutation.params.path)
          ) {
            sendJson(response, 200, { type: "error", requestId: envelope.requestId, error: { code: "PERMISSION_DENIED" } });
            return;
          }
        }
      } catch {
        sendJson(response, 400, { type: "error", requestId: envelope.requestId, error: { code: "INVALID_PARAMS" } });
        return;
      }

      const deadlineMs = Math.min(receivedAt + sessionRpcTimeoutMs, envelope.deadlineAt ? Date.parse(envelope.deadlineAt) : Infinity);
      if (deadlineMs <= now()) {
        sendJson(response, 200, { type: "error", requestId: envelope.requestId, error: { code: "DEADLINE_EXCEEDED" } });
        return;
      }
      try {
        const reply = await forwardToEngine({
          deadlineAt: isoDate(deadlineMs),
          type: "request",
          protocol: envelope.protocol,
          version: envelope.version,
          sessionId: envelope.sessionId,
          requestId: envelope.requestId,
          method: envelope.method,
          params: envelope.params,
          ...(envelope.permission ? { permission: envelope.permission } : {}),
        }, deadlineMs === receivedAt + sessionRpcTimeoutMs);
        sendJson(response, 200, reply);
      } catch (error) {
        const message = error instanceof Error ? error.message : "session rpc failed";
        const status = message === "no ready session" || message === "duplicate requestId" ? 409 : 503;
        sendJson(response, status, { error: message });
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
      || !pendingSession
      || pendingSession.expiresAt <= now()
      || token !== pendingSession.token
      || liveSession
    ) {
      rejectUpgrade(socket);
      return;
    }

    const issued = pendingSession;
    // Consume credentials before upgrade, but do NOT mark the session live until
    // the WebSocket handshake succeeds. A failed handshake must not brick the gateway.
    pendingSession = undefined;
    sessionWanted = false;
    wantedSessionId = undefined;

    let upgraded = false;
    const failHandshake = () => {
      if (upgraded || liveSession) return;
      logger("Reach session upgrade failed");
    };
    socket.once("close", failHandshake);
    socket.once("error", failHandshake);

    sessions.handleUpgrade(request, socket, head, (webSocket) => {
      upgraded = true;
      socket.off("close", failHandshake);
      socket.off("error", failHandshake);
      liveSession = {
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
    const session = liveSession;
    if (!session) {
      webSocket.close(1011, "missing session binding");
      return;
    }
    logger("Reach session connected");
    seenRequestIds.clear();

    const leakTimer = () => {
      if (leaseTimer) clearTimeout(leaseTimer);
      leaseTimer = setTimeout(sessionLimitReached, Math.max(0, session.leaseExpiresAt - now()));
    };
    leakTimer();
    resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (pendingRpcs.size > 0) resetIdleTimer?.();
        else sessionLimitReached();
      }, sessionIdleMs);
    };
    resetIdleTimer();

    webSocket.on("error", (error) => {
      logger(`Reach session socket error: ${error instanceof Error ? error.message : String(error)}`);
    });

    webSocket.on("message", (data, isBinary) => {
      resetIdleTimer?.();
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
        const pending = pendingRpcs.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingRpcs.delete(requestId);
        if (message.type === "error" && (message.error?.code === "DEADLINE_EXCEEDED" || message.error?.code === "SESSION_CLOSED")) {
          noteTimedOutRequest(requestId);
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
          engineVersion = ready.engineVersion;
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
        sessionWanted = false;
        lastClosureReason = reason;
        logger(`Reach session closed by engine: ${reason}`);
        if (leaseTimer) clearTimeout(leaseTimer);
        return;
      }

      if (message.type === "job.done") {
        // Legacy short-job completion: translate to a session close.
        session.closed = true;
        sessionWanted = false;
        lastClosureReason = CLOSURE_SESSION_COMPLETE;
        logger("Reach session job done");
        if (leaseTimer) clearTimeout(leaseTimer);
        if (idleTimer) clearTimeout(idleTimer);
        webSocket.close(1000, "job done");
        return;
      }

      // Unknown or malformed control message.
      webSocket.send(JSON.stringify({ type: "error", error: { code: "INVALID_PARAMS" } }));
    });

    webSocket.on("close", (code: number) => {
      if (leaseTimer) clearTimeout(leaseTimer);
      if (idleTimer) clearTimeout(idleTimer);
      resetIdleTimer = undefined;
      if (liveSession?.socket === webSocket) {
        // If the Engine never reported a closure reason before the socket ended,
        // classify the observed close: clean after an Agent close, a policy
        // limit, an RPC timeout, or an unexpected disconnect.
        if (lastClosureReason === undefined) {
          if (code === 1000) {
            lastClosureReason = session.closed ? CLOSURE_AGENT_REQUESTED : CLOSURE_DISCONNECTED;
          } else if (code === 1008) {
            lastClosureReason = "policy_limit";
          } else if (code === 1011) {
            lastClosureReason = "rpc_timeout";
          } else {
            lastClosureReason = CLOSURE_DISCONNECTED;
          }
        }
        liveSession = undefined;
      }
      seenRequestIds.clear();
      clearPendingRpcs("session closed");
      logger("Reach session closed");
    });
  });

  gateway.on("close", () => {
    if (leaseTimer) clearTimeout(leaseTimer);
    if (idleTimer) clearTimeout(idleTimer);
    clearPendingRpcs("gateway closed");
    liveSession?.socket.terminate();
  });
  return gateway;
}

async function readOptionalJsonBody(request: IncomingMessage): Promise<unknown> {
  const length = Number(request.headers["content-length"] ?? 0);
  if (length === 0 && !request.headers["transfer-encoding"]) return {};
  return readJsonBody(request);
}
