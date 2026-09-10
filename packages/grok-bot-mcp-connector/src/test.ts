import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "./config.js";
import { McpServer, MCP_PROTOCOL_VERSION } from "./server.js";

function readyGateway(overrides: Partial<{
  rpc: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  renew: () => Promise<{ leaseExpiresAt?: string }>;
  close: () => Promise<void>;
}> = {}) {
  return {
    openAndWait: async () => ({ leaseExpiresAt: new Date(Date.now() + 30_000).toISOString() }),
    renew: overrides.renew ?? (async () => ({ leaseExpiresAt: new Date(Date.now() + 300_000).toISOString() })),
    rpc: overrides.rpc ?? (async (method: string, params: Record<string, unknown>) => ({ type: "response", result: { method, params } })),
    close: overrides.close ?? (async () => {}),
  };
}

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

test("only configured devices can be picked after their Gateway is ready", async () => {
  const config = loadConfig({ REACH_MCP_DEVICES: JSON.stringify([{ id: "remote", gatewayUrl: "http://127.0.0.1:8787" }]) });
  const messages: Record<string, unknown>[] = [];
  let opened = 0;
  const server = new McpServer(config, (message) => messages.push(message), () => ({
    ...readyGateway(),
    openAndWait: async () => {
      opened += 1;
      return { leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() };
    },
  }));
  await server.receive({ jsonrpc: "2.0", id: 1, method: "initialize" });
  await server.receive({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(((messages[1].result as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name), ["list_devices", "pick_device"]);
  await server.receive({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "pick_device", arguments: { deviceId: "missing" } } });
  assert.equal((messages[2].result as { isError: boolean }).isError, true);
  await server.receive({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "pick_device", arguments: { deviceId: "remote" } } });
  assert.equal(opened, 1);
  assert.deepEqual(JSON.parse((((messages[3].result as { content: Array<{ text: string }> }).content)[0].text)), { selectedDeviceId: "remote", status: "ready" });
  assert.deepEqual(messages[4], { jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  await server.receive({ jsonrpc: "2.0", id: 5, method: "tools/list" });
  const refreshed = (messages[5].result as { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> }).tools;
  assert.deepEqual(refreshed.map((tool) => tool.name), ["list_devices", "pick_device", "fs.read", "fs.write", "fs.edit", "fs.list", "fs.glob", "fs.stat", "fs.grep", "session.close"]);
  assert.equal("deviceId" in refreshed.find((tool) => tool.name === "fs.read")!.inputSchema.properties, false);
});

test("filesystem calls renew then forward through the selected Gateway and close clears selection", async () => {
  const config = loadConfig({ REACH_MCP_RENEW_SKEW_MS: "60000" });
  const messages: Record<string, unknown>[] = [];
  const calls: string[] = [];
  const server = new McpServer(config, (message) => messages.push(message), () => readyGateway({
    renew: async () => {
      calls.push("renew");
      return { leaseExpiresAt: new Date(Date.now() + 300_000).toISOString() };
    },
    rpc: async (method, params) => {
      calls.push(`rpc:${method}`);
      return { type: "response", result: { remote: true, params } };
    },
    close: async () => { calls.push("close"); },
  }));
  await server.receive({ jsonrpc: "2.0", id: 1, method: "initialize" });
  await server.receive({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "pick_device", arguments: { deviceId: "local-engine" } } });
  await server.receive({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fs.read", arguments: { workspace: "default", path: "note.txt" } } });
  assert.deepEqual(calls.slice(0, 2), ["renew", "rpc:fs.read"]);
  assert.deepEqual(JSON.parse((((messages[3].result as { content: Array<{ text: string }> }).content)[0].text)), { remote: true, params: { workspace: "default", path: "note.txt" } });
  await server.receive({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "session.close", arguments: {} } });
  assert.equal(calls[2], "close");
  await server.receive({ jsonrpc: "2.0", id: 5, method: "tools/list" });
  assert.deepEqual(((messages[6].result as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name), ["list_devices", "pick_device"]);
});
