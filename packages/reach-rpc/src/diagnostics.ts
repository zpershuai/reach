const routes = new Set(["/healthz", "/heartbeat", "/mcp", "/session-wanted", "/session/open", "/session/status", "/session/renew", "/session/close", "/session/rpc", "/grants"]);
const codes = new Set(["UNAUTHORIZED", "INVALID_PARAMS", "PERMISSION_DENIED", "WORKSPACE_ACCESS_DENIED", "FILE_NOT_FOUND", "FILE_TOO_LARGE", "INVALID_UTF8", "INVALID_CURSOR", "REVISION_CONFLICT", "OLD_STRING_NOT_FOUND", "OLD_STRING_NOT_UNIQUE", "DEADLINE_EXCEEDED", "DUPLICATE_REQUEST_ID", "SESSION_CLOSED", "SESSION_NOT_READY", "LAUNCH_ID_CONFLICT", "PROCESS_CLEANUP_FAILED", "PROCESS_EXECUTION_DISABLED", "PROCESS_LIMIT_EXCEEDED", "PROCESS_NOT_FOUND", "PROCESS_UNSUPPORTED", "RUNTIME_UNAVAILABLE", "RESPONSE_TOO_LARGE", "TOOL_NOT_FOUND", "METHOD_NOT_FOUND", "FILE_EXISTS", "DIRECTORY_TOO_DEEP", "DIRECTORY_TOO_LARGE", "CURSOR_LIMIT_EXCEEDED", "TOO_MANY_REQUESTS", "INTERNAL_ERROR", "UPSTREAM_ERROR"]);

/** HTTP diagnostics describe the route, never a user-controlled URL or credential. */
export function diagnosticRoute(target: string | undefined): string {
  try {
    const path = new URL(target ?? "", "http://localhost").pathname;
    if (routes.has(path)) return path;
    if (path.startsWith("/api/console/")) return "/api/console/*";
    if (path.startsWith("/oauth/")) return "/oauth/*";
    if (path.startsWith("/.well-known/oauth-")) return "/.well-known/oauth-*";
    if (path === "/console" || path.startsWith("/console/")) return "/console/*";
  } catch { /* Invalid targets are not copied to logs. */ }
  return "/unknown";
}

export function diagnosticMethod(method: string | undefined): string {
  return method && ["GET", "POST", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS"].includes(method) ? method : "OTHER";
}

export function boundedMetadata(value: unknown, limit = 256): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, limit);
}

export function diagnosticCode(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" && codes.has(value) ? value : "UPSTREAM_ERROR";
}
import type { Server } from "node:http";

/** A startup error whose message is written by Reach and never contains configured values. */
export class ConfigurationError extends Error {
  override name = "ConfigurationError";
}


export function attachHttpDiagnostics(server: Server, logger: (line: string) => void = console.log): void {
  server.on("request", (request, response) => {
    const startedAt = Date.now();
    const path = diagnosticRoute(request.url);
    const method = diagnosticMethod(request.method);
    logger(JSON.stringify({ event: "http_request", method, path }));
    response.once("finish", () => logger(JSON.stringify({ event: "http_response", method, path,
      status: response.statusCode, durationMs: Date.now() - startedAt })));
  });
}
