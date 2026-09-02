import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";

export const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 120;
export const SESSION_WANTED_HEARTBEAT_INTERVAL_SECONDS = 5;

const heartbeatRequestSchema = z.object({
  device: z.record(z.unknown()),
});

const sessionWantedRequestSchema = z.object({
  wanted: z.boolean(),
});

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
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

export function createGateway(): Server {
  let sessionWanted = false;

  return createServer(async (request, response) => {
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

      sendJson(response, 200, {
        intervalSeconds: sessionWanted
          ? SESSION_WANTED_HEARTBEAT_INTERVAL_SECONDS
          : DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
      });
      return;
    }

    if (request.url === "/session-wanted") {
      try {
        sessionWanted = sessionWantedRequestSchema.parse(await readJsonBody(request)).wanted;
      } catch {
        sendJson(response, 400, { error: "invalid session-wanted payload" });
        return;
      }

      sendJson(response, 200, { wanted: sessionWanted });
      return;
    }

    sendJson(response, 404, { error: "not found" });
  });
}
