import type { ConnectorConfig } from "./config.js";

/** Stdio transport entrypoint; MCP request handling is installed by the server implementation. */
export function startStdioServer(_config: ConnectorConfig): void {
  process.stdin.resume();
}
