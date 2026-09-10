#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { startStdioServer } from "./server.js";

try {
  startStdioServer(loadConfig());
} catch (error) {
  process.stderr.write(`reach-grok-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
