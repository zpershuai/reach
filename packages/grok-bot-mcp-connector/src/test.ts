import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "./config.js";
import { McpServer, MCP_PROTOCOL_VERSION } from "./server.js";

function testServer() {
  const messages: Record<string, unknown>[] = [];
  const server = new McpServer(loadConfig({}), (message) => messages.push(message));
  return { server, messages };
}

test("initialize declares tools.listChanged", async () => {
  const { server, messages } = testServer();
  await server.receive({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_PROTOCOL_VERSION } });
  assert.deepEqual(messages, [{
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "reach-grok-bot-mcp", version: "0.1.0" },
    },
  }]);
});

test("tools require initialization and requests receive structured replies", async () => {
  const { server, messages } = testServer();
  await server.receive({ jsonrpc: "2.0", id: "before", method: "tools/list" });
  await server.receive({ jsonrpc: "2.0", id: "missing", method: "not/a/method" });
  assert.equal((messages[0].error as { code: number }).code, -32603);
  assert.equal((messages[1].error as { code: number }).code, -32603);
});

test("initialized is an accepted notification", async () => {
  const { server, messages } = testServer();
  await server.receive({ jsonrpc: "2.0", id: 1, method: "initialize" });
  await server.receive({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(messages.length, 1);
});
