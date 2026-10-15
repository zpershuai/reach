import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { sendJson } from "./http.js";

export function securityHeaders(response: ServerResponse): void {
  response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
}

const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== ".." && !child.startsWith(`..${sep}`) && !child.startsWith(sep);
}

export async function serveConsole(request: IncomingMessage, response: ServerResponse, directory: string): Promise<void> {
  securityHeaders(response);
  if (!["GET", "HEAD"].includes(request.method ?? "")) { sendJson(response, 405, { error: "Method not allowed" }); return; }
  let path: string;
  try { path = decodeURIComponent((request.url ?? "").split("?")[0]); }
  catch { sendJson(response, 400, { error: "Invalid asset path" }); return; }
  if (!path.startsWith("/console/") || path.includes("\\") || path.includes("\0") || path.split("/").includes("..")) {
    sendJson(response, 403, { error: "Invalid asset path" }); return;
  }
  const root = resolve(directory);
  let file = resolve(root, path.slice("/console/".length) || "index.html");
  if (!inside(root, file)) { sendJson(response, 403, { error: "Invalid asset path" }); return; }
  try {
    const index = resolve(root, "index.html");
    if (!(await stat(index)).isFile()) throw new Error("Missing console index");
    const candidate = await stat(file).catch(() => undefined);
    if (!candidate?.isFile()) file = index;
    const actualRoot = await realpath(root);
    if (!inside(actualRoot, await realpath(file))) { sendJson(response, 403, { error: "Invalid asset path" }); return; }
    const details = await stat(file);
    const hashed = /[.-][A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i.test(file);
    response.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream", "content-length": details.size,
      "cache-control": file === index ? "no-cache" : hashed ? "public, max-age=31536000, immutable" : "no-cache" });
    if (request.method === "HEAD") response.end();
    else await pipeline(createReadStream(file), response);
  } catch {
    if (response.headersSent) response.destroy();
    else sendJson(response, 503, { error: "Console assets unavailable; build packages/gateway-console first" });
  }
}
