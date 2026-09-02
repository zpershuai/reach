import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { z } from "zod";
import { WebSocket, WebSocketServer } from "ws";

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

    webSocket.on("message", (data, isBinary) => {
      if (isBinary || jobCompleted) {
        return;
      }

      try {
        const message = JSON.parse(data.toString()) as { type?: unknown };
        if (message.type !== "job.done") {
          return;
        }
      } catch {
        return;
      }

      jobCompleted = true;
      logger("Reach session job done");
      sessionWanted = false;
      webSocket.close(1000, "job done");
    });

    webSocket.on("close", () => {
      logger("Reach session closed");
    });
  });

  return gateway;
}
