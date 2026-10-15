import type { IncomingMessage, ServerResponse } from "node:http";
import { MAX_HTTP_BODY_BYTES } from "../gateway-policy.js";

export class PayloadTooLargeError extends Error {}
export class InvalidJsonError extends Error {}

export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
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
    throw new InvalidJsonError("invalid JSON");
  }
}

export function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

