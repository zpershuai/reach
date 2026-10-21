import { parseUpdateConfig } from "./gateway-update.js";
import { createGateway } from "./gateway.js";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { GATEWAY_VERSION } from "./version.js";
import { parseConsoleConfig } from "./console-api/config.js";
import { attachHttpDiagnostics, ConfigurationError } from "./diagnostics.js";

if (process.argv.includes("--version") || process.argv.includes("-V")) {
  console.log(GATEWAY_VERSION);
  process.exit(0);
}

function readEngines(path: string): { engineId: string; engineToken: string }[] {
  try {
    return z
      .array(z.object({ engineId: z.string().trim().min(1), engineToken: z.string().min(32) }))
      .parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    // Parser messages can quote file contents, which include Engine tokens.
    throw new ConfigurationError("REACH_ENGINES_FILE must be a readable JSON array of {engineId, engineToken} with tokens of at least 32 characters");
  }
}

function start(): void {
  const update = parseUpdateConfig(process.env);

  const port = Number(process.env.GATEWAY_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigurationError("GATEWAY_PORT must be an integer between 1 and 65535");
  }

  const host = process.env.GATEWAY_HOST ?? "127.0.0.1";
  const controllerToken = process.env.REACH_CONTROLLER_TOKEN;
  const engineToken = process.env.REACH_ENGINE_TOKEN;
  const engineId = process.env.REACH_ENGINE_ID;
  const authenticated =
    controllerToken !== undefined ||
    engineToken !== undefined ||
    engineId !== undefined;
  if (authenticated && (!controllerToken || !engineToken || !engineId)) {
    throw new ConfigurationError(
      "Set REACH_CONTROLLER_TOKEN, REACH_ENGINE_TOKEN and REACH_ENGINE_ID together",
    );
  }
  if (!["127.0.0.1", "::1", "localhost"].includes(host) && !authenticated) {
    throw new ConfigurationError("Non-loopback Gateway requires authentication");
  }
  const gateway = createGateway({
    console: parseConsoleConfig(process.env, host, port),
    update,
    mcp: {
      allowedOrigins: (process.env.REACH_MCP_ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      sessionIdleMs: Number(process.env.REACH_MCP_SESSION_IDLE_MS ?? 300_000),
      responseTimeoutMs: Number(
        process.env.REACH_MCP_RESPONSE_TIMEOUT_MS ?? 25_000,
      ),
      maxSessions: Number(process.env.REACH_MCP_MAX_SESSIONS ?? 128),
      maxQueue: Number(process.env.REACH_MCP_MAX_QUEUE ?? 16),
    },
    engines: process.env.REACH_ENGINES_FILE
      ? readEngines(process.env.REACH_ENGINES_FILE)
      : undefined,
    authentication: authenticated
      ? {
          controllerToken: controllerToken!,
          engineToken: engineToken!,
          engineId: engineId!,
        }
      : undefined,
    heartbeatIntervalSeconds: Number(
      process.env.REACH_HEARTBEAT_INTERVAL_SECS ?? 120,
    ),
  });
  if (process.env.REACH_HTTP_LOG === "1") {
    attachHttpDiagnostics(gateway);
  }
  gateway.listen(port, host, () => {
    console.log(
      `Reach gateway v${GATEWAY_VERSION} listening on http://${host}:${port}`,
    );
  });
}

try {
  start();
} catch (error) {
  // Reach-authored configuration messages name the setting, never its value; anything else
  // reports only its class so library text cannot echo private values into logs.
  console.error(error instanceof ConfigurationError
    ? `GATEWAY_CONFIGURATION_INVALID: ${error.message}`
    : `GATEWAY_STARTUP_FAILED: ${error instanceof Error ? error.name : "unknown error"}; check private environment, registry and data directory`);
  process.exitCode = 1;
}
