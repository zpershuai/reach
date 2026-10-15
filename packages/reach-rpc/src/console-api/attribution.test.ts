import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createGateway } from "../gateway.js";
import { InProcessGatewayClient, type EngineApi } from "../mcp/in-process.js";
import { RemoteMcpServer } from "../mcp/remote-server.js";
import type { CallerContext } from "./events.js";

test("in-process RPC and open receive the MCP caller context", async () => {
  const contexts: Array<CallerContext | undefined> = [];
  let sessionId: string | undefined;
  const result = { statusCode: 200, payload: {} };
  const api: EngineApi = {
    status: () => ({ status: sessionId ? "ready" : "none", sessionId, engineVersion: "1" }),
    open: (id, caller) => { sessionId = id; contexts.push(caller); return result; },
    rpc: async (_body, caller) => { contexts.push(caller); return result; },
    close: () => result, renew: () => result, grant: () => result,
  };
  const remote = new RemoteMcpServer(new Map([["engine-a", api]]), () => {}, "2025-06-18", "grok-bot 1.2", "mcp-id");
  const client = new InProcessGatewayClient(api, remote.caller);
  client.deadlineAt = Date.now() + 1000;
  await client.begin();
  await client.rpc("fs.read", { workspace: "default", path: "file.txt" });
  assert.deepEqual(contexts, [remote.caller, remote.caller]);
  assert.deepEqual(remote.caller, { type: "mcp-http", label: "grok-bot 1.2", verified: false, mcpSessionId: "mcp-id" });
});

test("REST and HTTP MCP initialize labels become Engine session owners", async () => {
  const token = "c".repeat(48);
  const gateway = createGateway({ authentication: { controllerToken: token, engineToken: "e".repeat(48), engineId: "engine-a" }, logger: () => {} });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  try {
    const address = gateway.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    for (const [header, expected] of [["Hermes Agent", "Hermes Agent"], ["x".repeat(65), "Controller API"], ["", "Controller API"]]) {
      assert.equal((await fetch(`${base}/session/open`, { method: "POST", headers: { ...headers, "x-reach-client": header }, body: "{}" })).status, 200);
      const status = await (await fetch(`${base}/session/status`, { headers })).json() as { ownerLabel: string };
      assert.equal(status.ownerLabel, expected);
      await fetch(`${base}/session/close`, { method: "POST", headers, body: "{}" });
    }
    const mcpHeaders = { ...headers, accept: "application/json, text/event-stream" };
    const initialized = await fetch(`${base}/mcp`, { method: "POST", headers: mcpHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "chatgpt", version: "1.0" } } }) });
    const sessionHeaders = { ...mcpHeaders, "mcp-session-id": initialized.headers.get("mcp-session-id")! };
    await fetch(`${base}/mcp`, { method: "POST", headers: sessionHeaders, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    await fetch(`${base}/mcp`, { method: "POST", headers: sessionHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "pick_device", arguments: { deviceId: "engine-a" } } }) });
    const status = await (await fetch(`${base}/session/status`, { headers })).json() as { ownerLabel: string };
    assert.equal(status.ownerLabel, "chatgpt 1.0");
    await fetch(`${base}/mcp`, { method: "DELETE", headers: sessionHeaders });
  } finally { await new Promise<void>(resolve => gateway.close(() => resolve())); }
});


test("an HTTP MCP session follows a removed and re-enrolled Engine identity", async () => {
  const opened: string[] = [];
  function engine(label: string): EngineApi {
    let sessionId: string | undefined;
    const result = { statusCode: 200, payload: {} };
    return {
      status: () => ({ status: sessionId ? "ready" : "none", sessionId, engineVersion: "1" }),
      open: id => { sessionId = id; opened.push(label); return result; },
      rpc: async () => result, close: () => { sessionId = undefined; return result; }, renew: () => result, grant: () => result,
    };
  }
  const engines = new Map([["engine-a", engine("original")]]);
  const messages: Array<Record<string, any>> = [];
  const remote = new RemoteMcpServer(engines, message => messages.push(message), "2025-06-18");
  await remote.receive({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  await remote.receive({ jsonrpc: "2.0", method: "notifications/initialized" });
  const pick = (id: number) => remote.receive({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "pick_device", arguments: { deviceId: "engine-a" } } });
  await pick(2);
  engines.delete("engine-a");
  await pick(3);
  assert.match(JSON.stringify(messages.at(-1)), /Unknown device/);
  engines.set("engine-a", engine("replacement"));
  await pick(4);
  assert.deepEqual(opened, ["original", "replacement"]);
  assert.ok(!messages.at(-1)!.result.isError);
  await remote.shutdown();
});
