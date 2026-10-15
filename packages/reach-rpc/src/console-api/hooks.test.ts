import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { WebSocket } from "ws";
import { createGateway } from "../gateway.js";
import { GatewayEvents } from "./events.js";
import { AuditWriter } from "./audit.js";
import { ConsoleStore } from "./store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function exercise(events?: GatewayEvents): Promise<string[]> {
  const gateway = createGateway({ events, logger: () => {}, sessionRpcTimeoutMs: 100 });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  let socket: WebSocket | undefined;
  try {
    const address = gateway.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "x-reach-client": "Hermes Agent", "content-type": "application/json" }, body: JSON.stringify(body) });
    const rpc = (requestId: string, method = "fs.read", params: unknown = { workspace: "default", path: "a.txt" }) => post("/session/rpc", { requestId, method, params });
    const results = [await (await rpc("no-route")).text()];
    await post("/session/open", { sessionId: "session-a" });
    const lease = await (await post("/heartbeat", { device: {} })).json() as { endpoint: string; token: string; sessionId: string };
    const endpoint = new URL(lease.endpoint, base.replace("http:", "ws:"));
    endpoint.searchParams.set("token", lease.token);
    socket = new WebSocket(endpoint);
    await once(socket, "open");
    socket.on("message", data => {
      const request = JSON.parse(String(data));
      if (request.type !== "request" || request.requestId === "timeout") return;
      const reply = request.requestId === "missing"
        ? { type: "error", requestId: request.requestId, error: { code: "FILE_NOT_FOUND" } }
        : { type: "response", requestId: request.requestId, result: { content: "private file content" } };
      socket!.send(JSON.stringify(reply));
    });
    socket.send(JSON.stringify({ type: "session.ready", protocol: "reach-rpc", version: "1.0", sessionId: lease.sessionId, engineId: "local-engine", workspaces: ["default"], methods: ["fs.read", "fs.write"] }));
    for (let attempt = 0; attempt < 100 && gateway.registry.apis.get("local-engine")!.status().status !== "ready"; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(gateway.registry.apis.get("local-engine")!.status().status, "ready");
    results.push(await (await rpc("read")).text());
    results.push(await (await rpc("missing")).text());
    results.push(await (await rpc("denied", "fs.write", { workspace: "default", path: "a.txt", content: "do not audit", mode: "create" })).text());
    results.push(await (await rpc("timeout")).text());
    const closed = socket.readyState === WebSocket.CLOSED ? Promise.resolve() : once(socket, "close");
    socket.terminate();
    await closed;
    return results;
  } finally {
    socket?.terminate();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
  }
}

test("RPC events report success, Engine errors, policy and route denial, and timeout without changing results", async () => {
  const events = new GatewayEvents();
  assert.deepEqual(await exercise(events), await exercise());
  const recorded = events.replay(0);
  const byRequest = (id: string) => recorded.filter(event => event.requestId === id);
  assert.deepEqual(byRequest("read").map(event => event.type), ["rpc.started", "rpc.finished"]);
  const read = byRequest("read")[1];
  assert.equal(read.outcome, "ok");
  assert.ok(read.latencyMs! >= 0);
  assert.equal(read.responseBytes, Buffer.byteLength(JSON.stringify({ type: "response", requestId: "read", result: { content: "private file content" } })));
  assert.equal(read.caller!.label, "Hermes Agent");
  assert.equal(byRequest("missing")[1].code, "FILE_NOT_FOUND");
  assert.equal(byRequest("missing")[1].outcome, "error");
  assert.deepEqual(byRequest("denied").map(event => [event.type, event.stage]), [["rpc.denied", "policy"]]);
  assert.equal(byRequest("no-route")[0].stage, "route");
  assert.equal(byRequest("timeout")[1].code, "DEADLINE_EXCEEDED");
  assert.equal(recorded.filter(event => event.type === "engine.heartbeat").length, 1);
  const statuses = recorded.filter(event => event.type === "session.state").map(event => event.status);
  assert.deepEqual(statuses, ["wanted", "pending", "connecting", "ready", "closing", "none"]);
  assert.ok(!JSON.stringify(recorded).includes("private file content"));
  assert.ok(!JSON.stringify(recorded).includes("do not audit"));
});

test("an audit write failure leaves RPC responses unchanged and marks storage unhealthy", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reach-audit-failure-"));
  const store = new ConsoleStore(directory);
  const events = new GatewayEvents();
  let warnings = 0;
  const writer = new AuditWriter(store, events, () => { warnings++; }, () => { throw new Error("disk full"); });
  try {
    assert.deepEqual(await exercise(events), await exercise());
    writer.flush();
    assert.equal(writer.storageHealth, false);
    assert.equal(warnings, 1);
  } finally { writer.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("authentication failures are aggregated by path and peer over 60 seconds", () => {
  let now = 0;
  const events = new GatewayEvents(() => now);
  for (let attempt = 0; attempt < 10; attempt++) events.authFailed("/mcp", "192.0.2.1");
  assert.equal(events.replay(0).length, 1);
  events.authFailed("/heartbeat", "192.0.2.1");
  events.authFailed("/mcp", "192.0.2.2");
  assert.equal(events.replay(0).length, 3);
  now = 60_000;
  events.authFailed("/mcp", "192.0.2.1");
  assert.equal(events.replay(0)[3].count, 10);
});

test("HTTP MCP creation, DELETE, idle and shutdown emit attributed lifecycle events", async () => {
  const events = new GatewayEvents();
  const token = "c".repeat(48);
  const gateway = createGateway({ events, logger: () => {}, authentication: { controllerToken: token, engineToken: "e".repeat(48), engineId: "engine-a" }, mcp: { sessionIdleMs: 100 } });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  try {
    const address = gateway.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
    const initialize = () => fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "chatgpt", version: "1.0" } } }) });
    const first = await initialize();
    await fetch(`${base}/mcp`, { method: "DELETE", headers: { ...headers, "mcp-session-id": first.headers.get("mcp-session-id")! } });
    await initialize();
    for (let attempt = 0; attempt < 100 && !events.replay(0).some(event => event.reason === "idle"); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    await initialize();
    await fetch(`${base}/mcp`, { headers: { authorization: "Bearer wrong" } });
    assert.equal(events.replay(0).filter(event => event.type === "auth.failed").length, 1);
  } finally { await new Promise<void>(resolve => gateway.close(() => resolve())); }
  const recorded = events.replay(0);
  assert.deepEqual(recorded.filter(event => event.type === "client.disconnected").map(event => event.reason), ["delete", "idle", "shutdown"]);
  assert.ok(recorded.filter(event => event.type.startsWith("client.")).every(event => event.caller!.label === "chatgpt 1.0"));
});
