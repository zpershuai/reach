import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { z } from "zod";
import { WebSocket, WebSocketServer } from "ws";
import {
  ContractError,
  parseFsEditParams,
  parseFsGlobParams,
  parseFsGrepParams,
  parseFsListParams,
  parseFsReadParams,
  parseFsStatParams,
  parseFsWriteParams,
  permissionSchema,
} from "./index.js";
import { FilesystemError, WorkspaceFilesystem } from "./workspace.js";

export const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 120;
export const SESSION_WANTED_HEARTBEAT_INTERVAL_SECONDS = 5;
export const SESSION_TOKEN_TTL_MS = 30_000;
export const MAX_HTTP_BODY_BYTES = 64 * 1024;
export const MAX_WEBSOCKET_TEXT_BYTES = 1024 * 1024;
export const MAX_SESSION_DURATION_MS = 5 * 60 * 1000;
export const MAX_SESSION_IDLE_MS = 60 * 1000;

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

export interface GatewayOptions {
  logger?: (message: string) => void;
  workspaceRoot?: string;
  now?: () => number;
  sessionDurationMs?: number;
  sessionIdleMs?: number;
}

interface PendingSession {
  token: string;
  expiresAt: number;
}

interface WriteGrant {
  workspace: string;
  path: string;
  methods: readonly ("fs.write" | "fs.edit")[];
  expiresAt: number;
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

export function createGateway(options: GatewayOptions = {}): Server {
  let sessionWanted = false;
  let pendingSession: PendingSession | undefined;
  let sessionLive = false;
  const grants = new Map<string, WriteGrant>();
  const logger = options.logger ?? console.log;
  const now = options.now ?? Date.now;
  const sessionDurationMs = options.sessionDurationMs ?? MAX_SESSION_DURATION_MS;
  const sessionIdleMs = options.sessionIdleMs ?? MAX_SESSION_IDLE_MS;
  const sessions = new WebSocketServer({ noServer: true });

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
      pendingSession ??= { token: randomUUID(), expiresAt: now() + SESSION_TOKEN_TTL_MS };
      const host = request.headers.host ?? "127.0.0.1";
      sendJson(response, 200, {
        intervalSeconds: SESSION_WANTED_HEARTBEAT_INTERVAL_SECONDS,
        wssUrl: `ws://${host}/session`,
        token: pendingSession.token,
      });
      return;
    }

    if (request.url === "/session-wanted") {
      try {
        sessionWanted = sessionWantedRequestSchema.parse(await readJsonBody(request)).wanted;
        // A control request is the explicit re-request boundary: old credentials
        // can never become valid again after it.
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

      const grantId = randomUUID();
      const expiresAt = Date.now() + GRANT_TTL_MS;
      grants.set(grantId, { ...grantRequest, expiresAt });
      sendJson(response, 200, { grantId, expiresAt: new Date(expiresAt).toISOString() });
      return;
    }

    sendJson(response, 404, { error: "not found" });
  });

  gateway.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://gateway");
    const token = url.searchParams.get("token");
    if (
      request.method !== "GET" ||
      url.pathname !== "/session" ||
      !pendingSession ||
      pendingSession.expiresAt <= now() ||
      token !== pendingSession.token ||
      sessionLive
    ) {
      rejectUpgrade(socket);
      return;
    }

    pendingSession = undefined;
    sessionWanted = false;
    sessionLive = true;
    sessions.handleUpgrade(request, socket, head, (webSocket) => {
      sessions.emit("connection", webSocket, request);
    });
  });

  sessions.on("connection", (webSocket: WebSocket) => {
    logger("Reach session connected");
    let jobCompleted = false;
    const workspace = new WorkspaceFilesystem(options.workspaceRoot);
    const closeForLimit = () => webSocket.close(1008, "session limit exceeded");
    const hardTimer = setTimeout(closeForLimit, sessionDurationMs);
    let idleTimer = setTimeout(closeForLimit, sessionIdleMs);
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(closeForLimit, sessionIdleMs);
    };

    webSocket.on("message", async (data, isBinary) => {
      resetIdleTimer();
      const text = Buffer.isBuffer(data)
        ? data
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : Buffer.concat(data);
      if (isBinary || text.length > MAX_WEBSOCKET_TEXT_BYTES) {
        webSocket.close(1009, "message too large");
        return;
      }
      if (jobCompleted) {
        return;
      }

      let message: { type?: unknown; requestId?: unknown; method?: unknown; params?: unknown; permission?: unknown };
      try {
        message = JSON.parse(text.toString()) as typeof message;
      } catch {
        return;
      }

      if (message.type === "request") {
        const requestId = typeof message.requestId === "string" ? message.requestId : undefined;
        try {
          const result = await dispatchFilesystem(workspace, grants, message.method, message.params, message.permission);
          webSocket.send(JSON.stringify({ type: "response", requestId, result }));
        } catch (error) {
          const code = error instanceof ContractError ? error.code : error instanceof FilesystemError ? error.code : "INVALID_PARAMS";
          webSocket.send(JSON.stringify({ type: "error", requestId, error: { code } }));
        }
        return;
      }

      if (message.type !== "job.done") return;

      jobCompleted = true;
      logger("Reach session job done");
      sessionWanted = false;
      webSocket.close(1000, "job done");
    });

    webSocket.on("close", () => {
      clearTimeout(hardTimer);
      clearTimeout(idleTimer);
      sessionLive = false;
      workspace.close();
      logger("Reach session closed");
    });
  });

  return gateway;
}

async function dispatchFilesystem(
  workspace: WorkspaceFilesystem,
  grants: ReadonlyMap<string, WriteGrant>,
  method: unknown,
  params: unknown,
  permission: unknown,
): Promise<unknown> {
  let name = method;
  let argumentsValue = params;
  if (name === "tool.call") {
    const tool = z.object({ name: z.string().min(1), arguments: z.unknown() }).safeParse(params);
    if (!tool.success) throw new ContractError();
    name = tool.data.name;
    argumentsValue = tool.data.arguments;
  }
  if (typeof name !== "string") throw new ContractError();
  if (name === "fs.read") return workspace.read(parseFsReadParams(argumentsValue));
  if (name === "fs.list") return workspace.list(parseFsListParams(argumentsValue));
  if (name === "fs.stat") return workspace.stat(parseFsStatParams(argumentsValue));
  if (name === "fs.glob") return workspace.glob(parseFsGlobParams(argumentsValue));
  if (name === "fs.grep") return workspace.grep(parseFsGrepParams(argumentsValue));
  if (name === "fs.write") {
    const parsedPermission = permissionSchema.safeParse(permission);
    const params = parseFsWriteParams(argumentsValue);
    if (!parsedPermission.success || !hasMatchingGrant(grants, parsedPermission.data.grantId, name, params.workspace, params.path)) {
      throw new FilesystemError("PERMISSION_DENIED");
    }
    return workspace.write(params);
  }
  if (name === "fs.edit") {
    const parsedPermission = permissionSchema.safeParse(permission);
    const params = parseFsEditParams(argumentsValue);
    if (!parsedPermission.success || !hasMatchingGrant(grants, parsedPermission.data.grantId, name, params.workspace, params.path)) {
      throw new FilesystemError("PERMISSION_DENIED");
    }
    return workspace.edit(params);
  }
  throw new FilesystemError("METHOD_NOT_FOUND");
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
  return grant.workspace === workspace
    && grant.methods.includes(method)
    && (path === grant.path || path.startsWith(`${grant.path.replace(/\/$/, "")}/`));
}
