#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { startStdioServer } from "./server.js";
import { MCP_VERSION } from "./version.js";

if (process.argv.includes("--version") || process.argv.includes("-V")) {
  console.log(MCP_VERSION);
  process.exit(0);
}

try {
  startStdioServer(loadConfig());
} catch {
  process.stderr.write("reach-mcp: CONFIGURATION_INVALID; check private client settings\n");
  process.exitCode = 1;
}
