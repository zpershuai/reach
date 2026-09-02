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

const heartbeatRequestSchema = z.object({
  device: z.record(z.unknown()),
});

const sessionWantedRequestSchema = z.object({
  wanted: z.boolean(),
});

export interface GatewayOptions {
  logger?: (message: string) => void;
  workspaceRoot?: string;
}

interface PendingSession {
  token: string;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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
  const logger = options.logger ?? console.log;
  const sessions = new WebSocketServer({ noServer: true });

  const gateway = createServer(async (request, response) => {
    if (request.method !== "POST") {
      sendJson(response, 404, { error: "not found" });
      return;
    }

    if (request.url === "/heartbeat") {
      try {
        heartbeatRequestSchema.parse(await readJsonBody(request));
      } catch {
        sendJson(response, 400, { error: "invalid heartbeat payload" });
        return;
      }

      if (!sessionWanted) {
        sendJson(response, 200, { intervalSeconds: DEFAULT_HEARTBEAT_INTERVAL_SECONDS });
        return;
      }

      pendingSession ??= { token: randomUUID() };
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
        if (!sessionWanted) {
          pendingSession = undefined;
        }
      } catch {
        sendJson(response, 400, { error: "invalid session-wanted payload" });
        return;
      }

      sendJson(response, 200, { wanted: sessionWanted });
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
      token !== pendingSession.token
    ) {
      rejectUpgrade(socket);
      return;
    }

    pendingSession = undefined;
    sessions.handleUpgrade(request, socket, head, (webSocket) => {
      sessions.emit("connection", webSocket, request);
    });
  });

  sessions.on("connection", (webSocket: WebSocket) => {
    logger("Reach session connected");
    let jobCompleted = false;
    const workspace = new WorkspaceFilesystem(options.workspaceRoot);

    webSocket.on("message", async (data, isBinary) => {
      if (isBinary || jobCompleted) {
        return;
      }

      let message: { type?: unknown; requestId?: unknown; method?: unknown; params?: unknown; permission?: unknown };
      try {
        message = JSON.parse(data.toString()) as typeof message;
      } catch {
        return;
      }

      if (message.type === "request") {
        const requestId = typeof message.requestId === "string" ? message.requestId : undefined;
        try {
          const result = await dispatchFilesystem(workspace, message.method, message.params, message.permission);
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
      workspace.close();
      logger("Reach session closed");
    });
  });

  return gateway;
}

async function dispatchFilesystem(
  workspace: WorkspaceFilesystem,
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
  if (name === "fs.write" || name === "fs.edit") {
    if (!permissionSchema.safeParse(permission).success) throw new FilesystemError("PERMISSION_DENIED");
    return name === "fs.write"
      ? workspace.write(parseFsWriteParams(argumentsValue))
      : workspace.edit(parseFsEditParams(argumentsValue));
  }
  throw new FilesystemError("METHOD_NOT_FOUND");
}
