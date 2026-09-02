import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { z } from "zod";
import { WebSocket, WebSocketServer } from "ws";
import { ContractError, parseFsEditParams, parseFsWriteParams, parseRequestEnvelope, permissionSchema } from "./index.js";

export const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 120;
export const SESSION_WANTED_HEARTBEAT_INTERVAL_SECONDS = 5;
export const SESSION_TOKEN_TTL_MS = 30_000;
export const MAX_HTTP_BODY_BYTES = 64 * 1024;
export const MAX_WEBSOCKET_TEXT_BYTES = 1024 * 1024;
export const MAX_SESSION_DURATION_MS = 5 * 60 * 1000;
export const MAX_SESSION_IDLE_MS = 60 * 1000;
export const SESSION_RPC_TIMEOUT_MS = 30_000;

const heartbeatRequestSchema = z.object({
  device: z.record(z.unknown()),
});

const sessionWantedRequestSchema = z.object({
  wanted: z.boolean(),
});

const grantRequestSchema = z.object({
  workspace: z.string().min(1),
  path: z.string().min(1),
  methods: z.array(z.enum(["fs.write", "fs.edit"])).min(1),
});

const GRANT_TTL_MS = 5 * 60 * 1000;
const toolCallSchema = z.object({ name: z.string().min(1), arguments: z.unknown() });

export interface GatewayOptions {
  logger?: (message: string) => void;
  now?: () => number;
  sessionDurationMs?: number;
  sessionIdleMs?: number;
  sessionRpcTimeoutMs?: number;
}

interface PendingSession {
  token: string;
  expiresAt: number;
  sessionId: string;
}

interface WriteGrant {
  workspace: string;
  path: string;
  methods: readonly ("fs.write" | "fs.edit")[];
  expiresAt: number;
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

/** Lexically normalize a workspace-relative path; reject empty / absolute / `..` escapes. */
export function normalizeWorkspacePath(path: string): string | undefined {
  const trimmed = path.trim();
  if (!trimmed || trimmed.startsWith("/") || trimmed.includes("\0")) return undefined;
  const parts: string[] = [];
  for (const part of trimmed.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") return undefined;
    parts.push(part);
  }
  return parts.join("/");
}

/**
 * Unwrap any depth of `tool.call` so nested mutations remain visible to grant checks.
 * Malformed tool chains resolve to an empty method (never treated as a mutation).
 */
function effectiveMethod(method: string, params: unknown): { method: string; params: unknown } {
  let currentMethod = method;
  let currentParams = params;
  // Bound unwrap depth to avoid pathological nesting.
  for (let depth = 0; depth < 8 && currentMethod === "tool.call"; depth += 1) {
    const tool = toolCallSchema.safeParse(currentParams);
    if (!tool.success) return { method: "", params: undefined };
    currentMethod = tool.data.name;
    currentParams = tool.data.arguments;
  }
  if (currentMethod === "tool.call") return { method: "", params: undefined };
  return { method: currentMethod, params: currentParams };
}

function leafMutation(method: string, params: unknown): { method: "fs.write" | "fs.edit"; params: { workspace: string; path: string } } | undefined {
  const leaf = effectiveMethod(method, params);
  if (leaf.method !== "fs.write" && leaf.method !== "fs.edit") return undefined;
  const parsed = leaf.method === "fs.write" ? parseFsWriteParams(leaf.params) : parseFsEditParams(leaf.params);
  return { method: leaf.method, params: parsed };
}

function purgeExpiredGrants(grants: Map<string, WriteGrant>, nowMs: number): void {
  for (const [grantId, grant] of grants) {
    if (grant.expiresAt <= nowMs) grants.delete(grantId);
  }
}

function hasMatchingGrant(
  grants: ReadonlyMap<string, WriteGrant>,
  grantId: string,
  method: "fs.write" | "fs.edit",
  workspace: string,
  path: string,
): boolean {
  const grant = grants.get(grantId);
  if (!grant || grant.expiresAt <= Date.now()) return false;
  const requestPath = normalizeWorkspacePath(path);
  const grantPath = normalizeWorkspacePath(grant.path);
  if (!requestPath || !grantPath) return false;
  return grant.workspace === workspace
    && grant.methods.includes(method)
    && (requestPath === grantPath || requestPath.startsWith(`${grantPath}/`));
}

export function createGateway(options: GatewayOptions = {}): Server {
  let sessionWanted = false;
  let pendingSession: PendingSession | undefined;
  let sessionLive = false;
  let liveSocket: WebSocket | undefined;
  let liveSessionId: string | undefined;
  let resetIdleTimer: (() => void) | undefined;
  const pendingRpcs = new Map<string, PendingRpc>();
  /** Request IDs already forwarded in the live session (including timed-out ones). */
  const seenRequestIds = new Set<string>();
  const grants = new Map<string, WriteGrant>();
  const logger = options.logger ?? console.log;
  const now = options.now ?? Date.now;
  const sessionDurationMs = options.sessionDurationMs ?? MAX_SESSION_DURATION_MS;
  const sessionIdleMs = options.sessionIdleMs ?? MAX_SESSION_IDLE_MS;
  const sessionRpcTimeoutMs = options.sessionRpcTimeoutMs ?? SESSION_RPC_TIMEOUT_MS;
  const sessions = new WebSocketServer({ noServer: true });

  const clearPendingRpcs = (reason: string) => {
    for (const [requestId, pending] of pendingRpcs) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      pendingRpcs.delete(requestId);
    }
  };

  const forwardToEngine = (envelope: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const socket = liveSocket;
    const sessionId = liveSessionId;
    if (!socket || socket.readyState !== WebSocket.OPEN || !sessionId) {
      return Promise.reject(new Error("no live session"));
    }
    const requestId = envelope.requestId;
    if (typeof requestId !== "string" || !requestId) {
      return Promise.reject(new Error("missing requestId"));
    }
    if (pendingRpcs.has(requestId) || seenRequestIds.has(requestId)) {
      return Promise.reject(new Error("duplicate requestId"));
    }

    const payload = { ...envelope, sessionId, type: "request", protocol: "reach-rpc", version: "1.0" };
    seenRequestIds.add(requestId);
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRpcs.delete(requestId);
        // Keep requestId in seenRequestIds so a timed-out mutation cannot be retried.
        reject(new Error("session rpc timeout"));
      }, sessionRpcTimeoutMs);
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
        socket.send(text);
      } catch (error) {
        clearTimeout(timer);
        pendingRpcs.delete(requestId);
        seenRequestIds.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  const gateway = createServer(async (request, response) => {
    if (request.method !== "POST") {
      sendJson(response, 404, { error: "not found" });
      return;
    }

    if (request.url === "/heartbeat") {
      try {
        heartbeatRequestSchema.parse(await readJsonBody(request));
      } catch (error) {
        sendJson(response, error instanceof PayloadTooLargeError ? 413 : 400, { error: "invalid heartbeat payload" });
        return;
      }

      if (!sessionWanted || sessionLive) {
        sendJson(response, 200, { intervalSeconds: DEFAULT_HEARTBEAT_INTERVAL_SECONDS });
        return;
      }

      if (pendingSession && pendingSession.expiresAt <= now()) pendingSession = undefined;
      pendingSession ??= { token: randomUUID(), expiresAt: now() + SESSION_TOKEN_TTL_MS, sessionId: randomUUID() };
      const host = request.headers.host ?? "127.0.0.1";
      sendJson(response, 200, {
        intervalSeconds: SESSION_WANTED_HEARTBEAT_INTERVAL_SECONDS,
        wssUrl: `ws://${host}/session`,
        token: pendingSession.token,
        sessionId: pendingSession.sessionId,
      });
      return;
    }

    if (request.url === "/session-wanted") {
      try {
        sessionWanted = sessionWantedRequestSchema.parse(await readJsonBody(request)).wanted;
        pendingSession = undefined;
      } catch (error) {
        sendJson(response, error instanceof PayloadTooLargeError ? 413 : 400, { error: "invalid session-wanted payload" });
        return;
      }

      sendJson(response, 200, { wanted: sessionWanted });
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

      purgeExpiredGrants(grants, Date.now());
      const grantId = randomUUID();
      const expiresAt = Date.now() + GRANT_TTL_MS;
      grants.set(grantId, { ...grantRequest, path: normalizedPath, expiresAt });
      sendJson(response, 200, { grantId, expiresAt: new Date(expiresAt).toISOString() });
      return;
    }

    if (request.url === "/session/rpc") {
      if (!sessionLive || !liveSocket || !liveSessionId) {
        sendJson(response, 409, { error: "no live session" });
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
          ? { type: "request", protocol: "reach-rpc", version: "1.0", sessionId: liveSessionId, ...(body as Record<string, unknown>) }
          : body;
        envelope = parseRequestEnvelope(candidate);
        if (envelope.sessionId !== liveSessionId) throw new ContractError();
      } catch {
        sendJson(response, 400, { type: "error", error: { code: "INVALID_PARAMS" } });
        return;
      }

      try {
        const mutation = leafMutation(envelope.method, envelope.params);
        if (mutation) {
          const permission = permissionSchema.safeParse(envelope.permission);
          if (
            !permission.success
            || !hasMatchingGrant(grants, permission.data.grantId, mutation.method, mutation.params.workspace, mutation.params.path)
          ) {
            sendJson(response, 200, { type: "error", requestId: envelope.requestId, error: { code: "PERMISSION_DENIED" } });
            return;
          }
        }
      } catch {
        sendJson(response, 400, { type: "error", requestId: envelope.requestId, error: { code: "INVALID_PARAMS" } });
        return;
      }

      try {
        const reply = await forwardToEngine({
          type: "request",
          protocol: envelope.protocol,
          version: envelope.version,
          sessionId: envelope.sessionId,
          requestId: envelope.requestId,
          method: envelope.method,
          params: envelope.params,
          ...(envelope.permission ? { permission: envelope.permission } : {}),
        });
        sendJson(response, 200, reply);
      } catch (error) {
        const message = error instanceof Error ? error.message : "session rpc failed";
        const status = message === "no live session" || message === "duplicate requestId" ? 409 : 503;
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
      || url.pathname !== "/session"
      || !pendingSession
      || pendingSession.expiresAt <= now()
      || token !== pendingSession.token
      || sessionLive
    ) {
      rejectUpgrade(socket);
      return;
    }

    const sessionId = pendingSession.sessionId;
    // Consume credentials before upgrade, but do NOT mark the session live until
    // the WebSocket handshake succeeds. A failed handshake must not brick the gateway.
    pendingSession = undefined;
    sessionWanted = false;

    let upgraded = false;
    const failHandshake = () => {
      if (upgraded || sessionLive) return;
      logger("Reach session upgrade failed");
    };
    socket.once("close", failHandshake);
    socket.once("error", failHandshake);

    sessions.handleUpgrade(request, socket, head, (webSocket) => {
      upgraded = true;
      socket.off("close", failHandshake);
      socket.off("error", failHandshake);
      sessionLive = true;
      liveSocket = webSocket;
      liveSessionId = sessionId;
      sessions.emit("connection", webSocket, request);
    });
  });

  sessions.on("connection", (webSocket: WebSocket) => {
    const sessionId = liveSessionId;
    if (!sessionId) {
      webSocket.close(1011, "missing session binding");
      return;
    }
    logger("Reach session connected");
    seenRequestIds.clear();
    let jobCompleted = false;
    const closeForLimit = () => webSocket.close(1008, "session limit exceeded");
    const hardTimer = setTimeout(closeForLimit, sessionDurationMs);
    let idleTimer = setTimeout(closeForLimit, sessionIdleMs);
    resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(closeForLimit, sessionIdleMs);
    };

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
      if (jobCompleted) return;

      let message: { type?: unknown; requestId?: unknown };
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
        pending.resolve(message as Record<string, unknown>);
        return;
      }

      // Model B: Engine-originated filesystem requests are not dispatched by Gateway.
      if (message.type === "request") return;

      if (message.type !== "job.done") return;

      jobCompleted = true;
      logger("Reach session job done");
      sessionWanted = false;
      webSocket.close(1000, "job done");
    });

    webSocket.on("close", () => {
      clearTimeout(hardTimer);
      clearTimeout(idleTimer);
      resetIdleTimer = undefined;
      sessionLive = false;
      liveSocket = undefined;
      liveSessionId = undefined;
      seenRequestIds.clear();
      clearPendingRpcs("session closed");
      logger("Reach session closed");
    });
  });

  return gateway;
}
