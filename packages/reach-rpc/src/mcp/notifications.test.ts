import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { test } from "node:test";
import { createGateway } from "../gateway.js";
import { createMcpHttpHandler, type McpHttpOptions } from "./http.js";
import { McpNotifications } from "./notifications.js";

const token = "c".repeat(48);
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" };

async function fixture(options: McpHttpOptions = {}) {
  const handler = createMcpHttpHandler(new Map(), token, options);
  const server = createServer((request, response) => { void handler.handle(request, response); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const connect = async (version = "2025-06-18", authorization = headers.authorization) => {
    const initialized = await fetch(url, { method: "POST", headers: { ...headers, authorization }, body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "notification-test", version: "1" } },
    }) });
    assert.equal(initialized.status, 200);
    const result = (await initialized.json() as any).result;
    assert.equal(result.capabilities.tools.listChanged, true);
    const sessionHeaders = { ...headers, authorization, "mcp-session-id": initialized.headers.get("mcp-session-id")!, "mcp-protocol-version": version };
    return {
      sessionHeaders,
      post: (message: unknown) => fetch(url, { method: "POST", headers: sessionHeaders, body: JSON.stringify(message) }),
      stream: () => fetch(url, { headers: sessionHeaders, signal: AbortSignal.timeout(3000) }),
      remove: () => fetch(url, { method: "DELETE", headers: sessionHeaders }),
    };
  };
  return { handler, server, url, connect, close: async () => { handler.shutdown(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

async function changed(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  let text = "";
  while (!text.includes("\n\n")) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false, "notification stream ended before delivering a change");
    text += new TextDecoder().decode(chunk.value);
  }
  const messages = text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
  assert.deepEqual(messages, [{ jsonrpc: "2.0", method: "notifications/tools/list_changed" }]);
}

test("HTTP MCP advertises listChanged, waits for initialized, and delivers notifications apart from POST replies", async () => {
  const f = await fixture();
  try {
    for (const version of ["2025-03-26", "2025-06-18"]) {
      const c = await f.connect(version);
      const stream = await c.stream();
      assert.equal(stream.status, 200);
      assert.equal(stream.headers.get("content-type"), "text/event-stream");
      assert.equal(stream.headers.get("x-accel-buffering"), "no");
      const reader = stream.body!.getReader();
      const firstChange = changed(reader);
      f.handler.notifyToolsChanged(); // Multiple changes before initialization coalesce.
      const ack = await c.post({ jsonrpc: "2.0", method: "notifications/initialized" });
      assert.equal(ack.status, 202);
      assert.equal(await ack.text(), "");
      await firstChange;
      const ping = await c.post({ jsonrpc: "2.0", id: 2, method: "ping" });
      assert.equal(ping.headers.get("content-type"), "application/json");
      assert.deepEqual(await ping.json(), { jsonrpc: "2.0", id: 2, result: {} });
      f.handler.notifyToolsChanged();
      await changed(reader);
      const list = await c.post({ jsonrpc: "2.0", id: 3, method: "tools/list" });
      const names = ((await list.json() as any).result.tools as Array<{ name: string }>).map(tool => tool.name);
      assert.ok(names.includes("list_workspaces"));
      // Replacing GET does not retire the session or duplicate a message across streams.
      const replacement = await c.stream();
      assert.equal((await reader.read()).done, true);
      const nextReader = replacement.body!.getReader();
      await changed(nextReader);
      assert.equal((await c.remove()).status, 200);
      assert.equal((await nextReader.read()).done, true);
    }
  } finally { await f.close(); }
});

test("notification streams enforce session identity, Origin, protocol and Accept", async () => {
  const f = await fixture({ oauth: { verify: authorization => authorization === "Bearer client-a" ? { id: "a" } : authorization === "Bearer client-b" ? { id: "b" } : undefined, challenge: () => "Bearer" } });
  try {
    const c = await f.connect("2025-06-18", "Bearer client-a");
    for (const [overrides, status] of [
      [{ authorization: "Bearer invalid" }, 401],
      [{ authorization: "Bearer client-b" }, 404],
      [{ origin: "https://unapproved.example.com" }, 403],
      [{ "mcp-protocol-version": "unknown" }, 400],
      [{ accept: "application/json" }, 406],
    ] as const) assert.equal((await fetch(f.url, { headers: { ...c.sessionHeaders, ...overrides } })).status, status);
    assert.equal((await fetch(f.url, { headers })).status, 400);
    await c.remove();
    assert.equal((await c.stream()).status, 404);
  } finally { await f.close(); }
});

test("an open GET does not prevent MCP idle expiry", async () => {
  const f = await fixture({ sessionIdleMs: 200 });
  try {
    const c = await f.connect();
    await c.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    const reader = (await c.stream()).body!.getReader();
    await changed(reader);
    assert.equal((await reader.read()).done, true);
    assert.equal((await c.post({ jsonrpc: "2.0", id: 2, method: "ping" })).status, 404);
    assert.deepEqual(f.handler.clients(), []);
  } finally { await f.close(); }
});

function responseFixture() {
  const writes: string[] = [];
  const response = Object.assign(new EventEmitter(), {
    destroyed: false, writableEnded: false, writableLength: 0,
    writeHead: () => {}, flushHeaders: () => {}, write: (text: string) => { writes.push(text); return true; },
    end: () => { response.writableEnded = true; response.emit("close"); },
    destroy: () => { response.destroyed = true; response.emit("close"); },
  });
  return { response, stream: response as unknown as ServerResponse, writes };
}

test("stalled notification readers are bounded and cannot block other sessions", () => {
  const stalled = responseFixture();
  stalled.response.writableLength = 1024 * 1024 + 1;
  const healthy = responseFixture();
  const a = new McpNotifications(); const b = new McpNotifications();
  try {
    a.ready(); b.ready();
    a.attach(stalled.stream, () => true); b.attach(healthy.stream, () => true);
    assert.equal(stalled.response.destroyed, true);
    assert.equal(healthy.writes.length, 1);
    b.toolsChanged();
    assert.equal(healthy.writes.length, 2);
  } finally { a.close(); b.close(); }
});

test("keepalives close a stream whose OAuth authorization is no longer valid", async () => {
  const f = responseFixture(); const notifications = new McpNotifications();
  let authorized = true;
  try {
    notifications.ready();
    notifications.attach(f.stream, () => authorized, 10);
    authorized = false;
    await once(f.response, "close");
    assert.equal(f.response.writableEnded, true);
  } finally { notifications.close(); }
});

test("Gateway close ends notification streams before closing its listener", async () => {
  const server = createGateway({ logger: () => {} });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/mcp`;
  try {
    const initialized = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "closing", version: "1" } } }) });
    await initialized.arrayBuffer();
    const sessionHeaders = { ...headers, "mcp-session-id": initialized.headers.get("mcp-session-id")! };
    await fetch(url, { method: "POST", headers: sessionHeaders, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    const reader = (await fetch(url, { headers: sessionHeaders, signal: AbortSignal.timeout(3000) })).body!.getReader();
    await changed(reader);
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.equal((await reader.read()).done, true);
  } finally { server.closeAllConnections(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); }
});
