import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";

export const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 120;
export const SESSION_WANTED_HEARTBEAT_INTERVAL_SECONDS = 5;

const heartbeatRequestSchema = z.object({
  device: z.record(z.unknown()),
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
  return createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/heartbeat") {
      sendJson(response, 404, { error: "not found" });
      return;
    }

    try {
      heartbeatRequestSchema.parse(await readJsonBody(request));
    } catch {
      sendJson(response, 400, { error: "invalid heartbeat payload" });
      return;
    }

    sendJson(response, 200, { intervalSeconds: DEFAULT_HEARTBEAT_INTERVAL_SECONDS });
  });
}
