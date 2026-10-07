import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as httpRequest, type ClientRequest } from "node:http";
import type { Socket } from "node:net";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { createMcpHttpHandler } from "./mcp/http.js";
import { createGateway, MAX_HTTP_BODY_BYTES, MAX_WEBSOCKET_TEXT_BYTES, type GatewayOptions } from "./gateway.js";

const controllerToken = "c".repeat(48);
const engineToken = "e".repeat(48);
const otherToken = "f".repeat(48);
const headers = { authorization: `Bearer ${controllerToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
const init = (version = "2025-06-18") => ({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "test", version: "1" } } });

async function withGateway(check: (url: string) => Promise<void>, options: GatewayOptions = {}, host = "127.0.0.1"): Promise<void> {
  const server = createGateway({ logger: () => {}, authentication: { controllerToken, engineToken, engineId: "engine-a" }, ...options });
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.listen(0, host);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try { await check(`http://127.0.0.1:${address.port}`); }
  finally { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

async function client(url: string, version = "2025-06-18") {
  const initialized = await fetch(`${url}/mcp`, { method: "POST", headers, body: JSON.stringify(init(version)) });
  assert.equal(initialized.status, 200, await initialized.clone().text());
  const sessionId = initialized.headers.get("mcp-session-id")!;
  assert.match(sessionId, /^[a-f0-9-]+$/);
  const result = await initialized.json() as { result: { protocolVersion: string; instructions: string } };
  const sessionHeaders = { ...headers, "mcp-session-id": sessionId, "mcp-protocol-version": result.result.protocolVersion };
  let sequence = 1;
  const post = (body: unknown, overrides: Record<string, string> = {}) => fetch(`${url}/mcp`, { method: "POST", headers: { ...sessionHeaders, ...overrides }, body: JSON.stringify(body) });
  const notify = () => post({ jsonrpc: "2.0", method: "notifications/initialized" });
  const request = async (method: string, params?: unknown) => {
    const response = await post({ jsonrpc: "2.0", id: ++sequence, method, params });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json() as { result: Record<string, any> }).result;
  };
  const tool = async (name: string, args: unknown = {}) => {
    const result = await request("tools/call", { name, arguments: args });
    return { result, value: result.isError ? result.content[0].text as string : JSON.parse(result.content[0].text) };
  };
  const remove = () => fetch(`${url}/mcp`, { method: "DELETE", headers: sessionHeaders });
  return { sessionId, sessionHeaders, initialized: result, post, notify, request, tool, remove };
}

async function status(url: string, engineId = "engine-a") {
  return (await fetch(`${url}/session/status${engineId === "engine-a" ? "" : `?engineId=${engineId}`}`, { headers })).json() as Promise<{ status: string; sessionId?: string }>;
}

function rawPost(url: string, requestHeaders: Record<string, string>, send: (request: ClientRequest) => void): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${url}/mcp`, { method: "POST", headers: requestHeaders, signal: AbortSignal.timeout(2000) }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => { resolve({ status: response.statusCode!, body }); request.destroy(); });
    });
    request.on("error", reject);
    send(request);
  });
}

async function mockEngine(url: string, engineId = "engine-a", token = engineToken, onRpc?: (message: Record<string, any>, socket: WebSocket) => void) {
  const heartbeat = await fetch(`${url}/heartbeat`, { method: "POST", headers: { ...headers, authorization: `Bearer ${token}` }, body: JSON.stringify({ device: { id: engineId, engineVersion: "1.2.3" } }) });
  const session = await heartbeat.json() as { endpoint: string; token: string; sessionId: string };
  assert.ok(session.endpoint, "Open intent before starting mock Engine");
  const separator = session.endpoint.includes("?") ? "&" : "?";
  const socket = new WebSocket(`${url.replace("http:", "ws:")}${session.endpoint}${separator}token=${session.token}`);
  await once(socket, "open");
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === "request") {
      if (onRpc) onRpc(message, socket);
      else socket.send(JSON.stringify({ type: "response", requestId: message.requestId, result: { engineId, method: message.method, params: message.params } }));
    }
    if (message.type === "session.close") {
      socket.send(JSON.stringify({ type: "session.closed", sessionId: session.sessionId, reason: "agent_requested" }));
      socket.close();
    }
  });
  socket.send(JSON.stringify({ type: "session.ready", protocol: "reach-rpc", version: "1.0", sessionId: session.sessionId, engineId, engineVersion: "1.2.3", workspaces: ["default"], methods: ["fs.read", "fs.write", "fs.edit"] }));
  for (let n = 0; n < 100 && (await status(url, engineId)).status !== "ready"; n++) await delay(5);
  assert.equal((await status(url, engineId)).status, "ready");
  return socket;
}

test("MCP authenticates every method, validates Origin and only allows unauthenticated loopback listeners", async () => {
  await withGateway(async (url) => {
    for (const method of ["POST", "GET", "DELETE"]) {
      for (const token of ["", engineToken, "incorrect"]) {
        assert.equal((await fetch(`${url}/mcp`, { method, headers: { authorization: `Bearer ${token}` } })).status, 401);
      }
    }
    assert.equal((await fetch(`${url}/mcp`, { method: "POST", headers: { ...headers, origin: "https://evil.example" }, body: JSON.stringify(init()) })).status, 403);
    const allowed = await fetch(`${url}/mcp`, { method: "POST", headers: { ...headers, origin: "https://client.example" }, body: JSON.stringify(init()) });
    assert.equal(allowed.status, 200);
    assert.equal((await fetch(`${url}/healthz`)).status, 200);
  }, { mcp: { allowedOrigins: ["https://client.example"] } });
  await withGateway(async (url) => {
    assert.equal((await fetch(`${url}/mcp`, { method: "POST", headers: { ...headers, authorization: "" }, body: JSON.stringify(init()) })).status, 200);
  }, { authentication: undefined });
  await withGateway(async (url) => {
    assert.equal((await fetch(`${url}/mcp`, { method: "POST", headers, body: JSON.stringify(init()) })).status, 401);
  }, { authentication: undefined }, "0.0.0.0");
});

test("MCP negotiates versions and enforces session, initialization and HTTP message semantics", async () => {
  await withGateway(async (url) => {
    const c = await client(url, "2099-01-01");
    assert.equal(c.initialized.result.protocolVersion, "2025-06-18");
    assert.match(c.initialized.result.instructions, /trusted workspace scripts/);
    assert.match(c.initialized.result.instructions, /Engine account privileges/);
    assert.match(c.initialized.result.instructions, /launchId.*process_status/);
    assert.equal((await c.post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).status, 400);
    const ack = await c.notify(); assert.equal(ack.status, 202); assert.equal(await ack.text(), "");
    assert.deepEqual(await c.request("ping"), {});
    const tools = (await c.request("tools/list")).tools;
    assert.equal(tools.length, 17);
    const statusSchema = tools.find((tool: { name: string }) => tool.name === "process_status").inputSchema;
    assert.deepEqual(statusSchema.oneOf, [
      { required: ["processId"], not: { required: ["launchId"] } },
      { required: ["launchId"], not: { required: ["processId"] } },
    ]);
    assert.ok(statusSchema.required.includes("deviceId"));
    for (const tool of tools) {
      assert.match(tool.name, /^[a-zA-Z0-9_-]{1,64}$/);
      if (tool.name.startsWith("fs_") || tool.name === "session_close") assert.ok(tool.inputSchema.required.includes("deviceId"));
    }
    assert.equal((await c.post(init())).status, 400);
    assert.equal((await c.post({ jsonrpc: "2.0", id: 9, method: "ping" }, { "mcp-protocol-version": "unknown" })).status, 400);
    assert.equal((await c.post({ jsonrpc: "2.0", id: 9, method: "ping" }, { "mcp-protocol-version": "2025-03-26" })).status, 400);
    assert.equal((await c.post([{ jsonrpc: "2.0", id: 9, method: "ping" }])).status, 400);
    assert.equal((await fetch(`${url}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }) })).status, 400);
    const missing = { ...c.sessionHeaders, "mcp-session-id": "missing" };
    assert.equal((await fetch(`${url}/mcp`, { method: "DELETE", headers: missing })).status, 404);
    assert.equal((await fetch(`${url}/mcp`, { method: "GET", headers: missing })).status, 404);
    assert.equal((await fetch(`${url}/mcp`, { method: "GET", headers: c.sessionHeaders })).status, 405);
    assert.equal((await c.post({ jsonrpc: "2.0", method: "tools/call", params: { name: "pick_device", arguments: { deviceId: "engine-a" } } })).status, 400);
    assert.equal((await status(url)).status, "none", "A malformed tool notification cannot open an Engine session");
    assert.equal((await c.post({ jsonrpc: "2.0", id: 9, method: "ping" }, { accept: "application/json" })).status, 406);
    assert.equal((await c.post({ jsonrpc: "2.0", id: 9, method: "ping" }, { "content-type": "text/plain" })).status, 415);
    assert.equal((await c.post({ jsonrpc: "2.0", id: null, method: "ping" })).status, 400);
    const unknown = await c.post({ jsonrpc: "2.0", id: 9, method: "unknown" });
    assert.equal((await unknown.json() as any).error.code, -32601);
    assert.equal((await c.remove()).status, 200);
    assert.equal((await c.post({ jsonrpc: "2.0", id: 9, method: "ping" })).status, 404);
    const legacy = await client(url, "2025-03-26");
    await legacy.notify();
    const batch = await legacy.post([{ jsonrpc: "2.0", id: 10, method: "ping" }, { jsonrpc: "2.0", method: "notifications/test" }, { jsonrpc: "2.0", id: 11, method: "tools/list" }]);
    assert.deepEqual((await batch.json() as any[]).map((message) => message.id), [10, 11]);
    const notifications = await legacy.post([{ jsonrpc: "2.0", method: "notifications/test" }]);
    assert.equal(notifications.status, 202); assert.equal(await notifications.text(), "");
  });
});

test("MCP lists registered devices, preserves cold-start intents and expires only its own sessions", async () => {
  await withGateway(async (url) => {
    const c = await client(url); await c.notify();
    const listed = (await c.tool("list_devices")).value.devices;
    assert.deepEqual(listed.map((device: any) => device.id), ["engine-a", "engine-b"]);
    assert.equal(listed[0].lastSeenAt, null);
    const started = Date.now();
    assert.equal((await c.tool("fs_read", { deviceId: "engine-a", workspace: "default", path: "note.txt" })).value.status, "connecting");
    assert.ok(Date.now() - started < 1000);
    const identity = (await status(url)).sessionId;
    for (let n = 0; n < 3; n++) {
      assert.equal((await c.tool("device_status", { deviceId: "engine-a" })).value.owned, true);
      assert.equal((await status(url)).sessionId, identity);
    }
    const second = await client(url); await second.notify();
    assert.match((await second.tool("pick_device", { deviceId: "engine-a" })).value, /^ENGINE_BUSY:/);
    assert.equal((await second.remove()).status, 200);
    assert.equal((await status(url)).sessionId, identity);
    assert.equal((await c.remove()).status, 200);
    assert.equal((await status(url)).status, "none");
    const abandoned = await client(url); await abandoned.notify();
    await abandoned.tool("pick_device", { deviceId: "engine-b" });
    await delay(140);
    assert.equal((await abandoned.post({ jsonrpc: "2.0", id: 9, method: "ping" })).status, 404);
    assert.equal((await status(url, "engine-b")).status, "none");
  }, { engines: [{ engineId: "engine-b", engineToken: otherToken }], mcp: { sessionIdleMs: 80 } });
});

test("MCP owns multiple devices without routing races and rejects a competing REST controller", async () => {
  await withGateway(async (url) => {
    const c = await client(url); await c.notify();
    for (const deviceId of ["engine-a", "engine-b"]) await c.tool("pick_device", { deviceId });
    const a = await mockEngine(url);
    const b = await mockEngine(url, "engine-b", otherToken);
    try {
      const reads = await Promise.all(["engine-a", "engine-b", "engine-a", "engine-b"].map((deviceId) => c.tool("fs_read", { deviceId, workspace: "default", path: deviceId })));
      assert.deepEqual(reads.map((read) => read.value.engineId), ["engine-a", "engine-b", "engine-a", "engine-b"]);
      const rest = await fetch(`${url}/session/open?engineId=engine-a`, { method: "POST", headers, body: JSON.stringify({ sessionId: "other-owner" }) });
      assert.equal(rest.status, 409);
      assert.equal((await c.tool("list_devices")).value.devices[0].engineVersion, "1.2.3");
      assert.ok((await c.tool("list_devices")).value.devices[0].lastSeenAt);
      assert.equal((await c.remove()).status, 200);
      assert.equal((await status(url)).status, "none");
      assert.equal((await status(url, "engine-b")).status, "none");
    } finally { a.terminate(); b.terminate(); }
  }, { engines: [{ engineId: "engine-b", engineToken: otherToken }] });
});

test("MCP respects existing REST ownership, payload limits, session caps and bounded RPC deadlines", async () => {
  await withGateway(async (url) => {
    await fetch(`${url}/session/open`, { method: "POST", headers, body: JSON.stringify({ sessionId: "stdio-owner" }) });
    const c = await client(url); await c.notify();
    assert.match((await c.tool("pick_device", { deviceId: "engine-a" })).value, /^ENGINE_BUSY:/);
    assert.equal((await c.remove()).status, 200);
    assert.equal((await status(url)).sessionId, "stdio-owner");
  });
  await withGateway(async (url) => {
    const c = await client(url); await c.notify();
    assert.equal((await fetch(`${url}/mcp`, { method: "POST", headers, body: JSON.stringify(init()) })).status, 503);
    assert.equal((await c.post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fs_write", arguments: { content: "x".repeat(65536) } } })).status, 413);
    await c.tool("pick_device", { deviceId: "engine-a" });
    let forwarded = 0;
    const engine = await mockEngine(url, "engine-a", engineToken, () => { forwarded++; });
    try {
      const started = Date.now();
      const pending = c.tool("fs_write", { deviceId: "engine-a", workspace: "default", path: "note.txt", content: "hi", mode: "create" });
      while (!forwarded) await delay(1);
      assert.equal((await c.post({ jsonrpc: "2.0", id: 8, method: "ping" })).status, 429);
      const outcome = await pending;
      assert.match(outcome.value, /^DEADLINE_EXCEEDED:/);
      assert.equal(forwarded, 1);
      assert.ok(Date.now() - started < 1000);
      assert.equal((await status(url)).status, "ready");
      assert.equal((await c.remove()).status, 200);
    } finally { engine.terminate(); }
  }, { mcp: { maxSessions: 1, maxQueue: 1, responseTimeoutMs: 150 } });
});

test("MCP rejects malformed JSON, bounds chunked bodies and times out incomplete bodies", async () => {
  await withGateway(async (url) => {
    const malformed = await rawPost(url, headers, (request) => request.end("{"));
    assert.equal(malformed.status, 400);
    assert.equal(JSON.parse(malformed.body).error.code, -32700);
    const overflow = await rawPost(url, headers, (request) => {
      request.write("x".repeat(32768)); request.end("x".repeat(32769));
    });
    assert.equal(overflow.status, 413);
    const started = Date.now();
    const slow = await rawPost(url, headers, (request) => { request.write("{"); });
    assert.equal(slow.status, 408);
    assert.ok(Date.now() - started < 1000);
  }, { mcp: { responseTimeoutMs: 100 } });
});

test("MCP idle expiry drains a ready Engine", async () => {
  await withGateway(async (url) => {
    const c = await client(url); await c.notify();
    await c.tool("pick_device", { deviceId: "engine-a" });
    const engine = await mockEngine(url);
    try {
      await delay(180);
      assert.equal((await c.post({ jsonrpc: "2.0", id: 9, method: "ping" })).status, 404);
      assert.equal((await status(url)).status, "none");
    } finally { engine.terminate(); }
  }, { mcp: { sessionIdleMs: 100 } });
});

test("MCP retains failed cleanup and cannot close a successor's Engine session", async () => {
  await withGateway(async (url) => {
    const c = await client(url); await c.notify();
    await c.tool("pick_device", { deviceId: "engine-a" });
    const engine = await mockEngine(url);
    engine.removeAllListeners("message"); // Simulate an Engine that cannot acknowledge close.
    try {
      assert.ok([408, 503].includes((await c.remove()).status));
      assert.equal((await fetch(`${url}/mcp`, { method: "POST", headers, body: JSON.stringify(init()) })).status, 503, "Failed cleanup still counts toward the cap");
      engine.terminate();
      for (let n = 0; n < 100 && (await status(url)).status !== "none"; n++) await delay(5);
      assert.equal((await fetch(`${url}/session/open`, { method: "POST", headers, body: JSON.stringify({ sessionId: "successor" }) })).status, 200);
      await delay(1100);
      assert.equal((await status(url)).sessionId, "successor");
      const next = await client(url); await next.notify();
      assert.match((await next.tool("pick_device", { deviceId: "engine-a" })).value, /^ENGINE_BUSY:/);
      assert.equal((await next.remove()).status, 200);
      assert.equal((await status(url)).sessionId, "successor");
    } finally { engine.terminate(); }
  }, { mcp: { maxSessions: 1, responseTimeoutMs: 100 } });
});

test("MCP rejects a POST body completed after DELETE without reopening the Engine", async () => {
  await withGateway(async (url) => {
    const c = await client(url); await c.notify();
    await c.tool("pick_device", { deviceId: "engine-a" });
    const body = JSON.stringify({ jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "pick_device", arguments: { deviceId: "engine-a" } } });
    let writing: ClientRequest | undefined;
    const pending = rawPost(url, c.sessionHeaders, (request) => { writing = request; request.write(body.slice(0, 10)); });
    try {
      await delay(30);
      assert.equal((await c.remove()).status, 200);
      assert.equal((await status(url)).status, "none");
      writing!.end(body.slice(10));
      assert.equal((await pending).status, 404);
      assert.equal((await status(url)).status, "none", "A retired MCP session must not recreate an Engine intent");
      const next = await client(url); await next.notify();
      assert.equal((await next.tool("pick_device", { deviceId: "engine-a" })).value.status, "connecting");
      assert.equal((await next.remove()).status, 200);
    } finally { writing?.destroy(); await pending.catch(() => undefined); }
  });
});

test("MCP body reads pin session activity across the idle TTL", async () => {
  await withGateway(async (url) => {
    const c = await client(url); await c.notify();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "pick_device", arguments: { deviceId: "engine-a" } } });
    let writing: ClientRequest | undefined;
    const pending = rawPost(url, c.sessionHeaders, (request) => { writing = request; request.write(body.slice(0, 10)); });
    try {
      await delay(180);
      writing!.end(body.slice(10));
      assert.equal((await pending).status, 200);
      assert.equal((await c.post({ jsonrpc: "2.0", id: 21, method: "ping" })).status, 200);
      assert.equal((await c.tool("device_status", { deviceId: "engine-a" })).value.owned, true);
      assert.equal((await c.remove()).status, 200);
      assert.equal((await status(url)).status, "none");
    } finally { writing?.destroy(); await pending.catch(() => undefined); }
  }, { mcp: { sessionIdleMs: 80, responseTimeoutMs: 1000 } });
});

test("MCP body reads count toward queue admission", async () => {
  await withGateway(async (url) => {
    const c = await client(url); await c.notify();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 20, method: "ping" });
    let writing: ClientRequest | undefined;
    const pending = rawPost(url, c.sessionHeaders, (request) => { writing = request; request.write(body.slice(0, 10)); });
    try {
      await delay(30);
      assert.equal((await c.post({ jsonrpc: "2.0", id: 21, method: "ping" })).status, 429);
      writing!.end(body.slice(10));
      assert.equal((await pending).status, 200);
      assert.equal((await c.post({ jsonrpc: "2.0", id: 22, method: "ping" })).status, 200);
    } finally { writing?.destroy(); await pending.catch(() => undefined); }
  }, { mcp: { maxQueue: 1 } });
});

test("MCP request-path expiry drains an intent before the next sweep", async () => {
  await withGateway(async (url) => {
    const c = await client(url); await c.notify();
    await c.tool("pick_device", { deviceId: "engine-a" });
    await delay(100);
    await c.request("ping");
    await delay(1050);
    assert.equal((await c.post({ jsonrpc: "2.0", id: 20, method: "ping" })).status, 404);
    assert.equal((await status(url)).status, "none");
  }, { mcp: { sessionIdleMs: 1000 } });
});

test("MCP cannot report another owner's session as closed and preserves local validation messages", async () => {
  await withGateway(async (url) => {
    const owner = await client(url); await owner.notify();
    const other = await client(url); await other.notify();
    await owner.tool("pick_device", { deviceId: "engine-a" });
    const identity = (await status(url)).sessionId;
    assert.match((await other.tool("session_close", { deviceId: "engine-a" })).value, /^ENGINE_BUSY:/);
    assert.match((await other.tool("pick_device", { deviceId: "engine-a" })).value, /^ENGINE_BUSY:/);
    assert.match((await other.tool("session_close", { deviceId: "engine-a" })).value, /^ENGINE_BUSY:/);
    assert.equal((await status(url)).sessionId, identity);
    const engine = await mockEngine(url);
    try {
      const invalid = await owner.tool("fs_write", { deviceId: "engine-a", workspace: "default", content: "hi", mode: "create" });
      assert.equal(invalid.result.isError, true);
      assert.equal(invalid.value, "fs.write requires non-empty workspace and path for a Gateway grant");
      assert.equal((await owner.remove()).status, 200);
      assert.deepEqual((await other.tool("session_close", { deviceId: "engine-a" })).value, { closedDeviceId: "engine-a", closed: false, owned: false });
    } finally { engine.terminate(); }
  });
});

test("MCP close reports owned work and repeated no-op explicitly", async () => {
  await withGateway(async url => {
    const c = await client(url); await c.notify();
    await c.tool("pick_device", { deviceId: "engine-a" });
    assert.deepEqual((await c.tool("session_close", { deviceId: "engine-a" })).value, { closedDeviceId: "engine-a", closed: true, owned: true });
    assert.deepEqual((await c.tool("session_close", { deviceId: "engine-a" })).value, { closedDeviceId: "engine-a", closed: false, owned: false });
  });
});

test("MCP accepts near-limit writes while REST still enforces its HTTP body limit", async () => {
  await withGateway(async (url) => {
    const c = await client(url); await c.notify();
    await c.tool("pick_device", { deviceId: "engine-a" });
    let forwardedBytes = 0;
    const engine = await mockEngine(url, "engine-a", engineToken, (message, socket) => {
      forwardedBytes = Buffer.byteLength(JSON.stringify(message));
      socket.send(JSON.stringify({ type: "response", requestId: message.requestId, result: { written: true } }));
    });
    try {
      const request = { jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "fs_write", arguments: { deviceId: "engine-a", workspace: "default", path: "large.txt", content: "", mode: "create" } } };
      request.params.arguments.content = "x".repeat(MAX_HTTP_BODY_BYTES - 8 - Buffer.byteLength(JSON.stringify(request)));
      assert.equal(Buffer.byteLength(JSON.stringify(request)), MAX_HTTP_BODY_BYTES - 8);
      const response = await c.post(request);
      assert.equal(response.status, 200);
      const reply = await response.json() as { result: { isError?: boolean } };
      assert.ok(!reply.result.isError, JSON.stringify(reply));
      assert.ok(forwardedBytes > MAX_HTTP_BODY_BYTES && forwardedBytes < MAX_WEBSOCKET_TEXT_BYTES);
      assert.equal((await fetch(`${url}/session/rpc`, { method: "POST", headers, body: JSON.stringify({ content: "x".repeat(MAX_HTTP_BODY_BYTES) }) })).status, 413);
      assert.equal((await c.remove()).status, 200);
    } finally { engine.terminate(); }
  });
});

test("MCP concurrent initialization respects a single available session slot", async () => {
  await withGateway(async (url) => {
    const responses = await Promise.all(Array.from({ length: 12 }, () => fetch(`${url}/mcp`, { method: "POST", headers, body: JSON.stringify(init()) })));
    assert.equal(responses.filter((response) => response.status === 200).length, 1);
    assert.equal(responses.filter((response) => response.status === 503).length, 11);
  }, { mcp: { maxSessions: 1 } });
});

test("MCP DELETE drains running work and rejects a write still waiting in the queue", async () => {
  await withGateway(async (url) => {
    const c = await client(url); await c.notify();
    await c.tool("pick_device", { deviceId: "engine-a" });
    const forwarded: string[] = [];
    let completeRead: (() => void) | undefined;
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => { readStarted = resolve; });
    const engine = await mockEngine(url, "engine-a", engineToken, (message, socket) => {
      forwarded.push(message.method);
      const reply = () => socket.send(JSON.stringify({ type: "response", requestId: message.requestId, result: { content: "hi" } }));
      if (message.method === "fs.read") { completeRead = reply; readStarted(); }
      else reply();
    });
    const running = c.tool("fs_read", { deviceId: "engine-a", workspace: "default", path: "note.txt" });
    await started;
    const queued = c.post({ jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "fs_write", arguments: { deviceId: "engine-a", workspace: "default", path: "note.txt", content: "wrong", mode: "overwrite" } } });
    await delay(30);
    const deleting = c.remove();
    try {
      const deadline = Date.now() + 1000;
      while ((await fetch(`${url}/mcp`, { method: "GET", headers: c.sessionHeaders })).status !== 404) {
        assert.ok(Date.now() < deadline, "DELETE should retire the MCP session immediately");
        await delay(5);
      }
      completeRead!();
      completeRead = undefined;
      assert.equal((await running).value.content, "hi");
      assert.equal((await queued).status, 404);
      assert.equal((await deleting).status, 200);
      assert.deepEqual(forwarded, ["fs.read"]);
      assert.equal((await status(url)).status, "none");
    } finally {
      completeRead?.(); engine.terminate();
      await Promise.allSettled([running, queued, deleting]);
    }
  });
});

test("MCP releases a body-read admission slot after a timeout", async () => {
  await withGateway(async (url) => {
    const c = await client(url); await c.notify();
    const timedOut = await rawPost(url, c.sessionHeaders, (request) => { request.write("{"); });
    assert.equal(timedOut.status, 408);
    assert.equal((await c.post({ jsonrpc: "2.0", id: 20, method: "ping" })).status, 200);
    assert.equal((await c.remove()).status, 200);
  }, { mcp: { maxQueue: 1, responseTimeoutMs: 100 } });
});

test("MCP shutdown rejects a body still being read without starting an Engine", async () => {
  const handler = createMcpHttpHandler(new Map(), controllerToken);
  const server = createServer((request, response) => { void handler.handle(request, response); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  let writing: ClientRequest | undefined;
  try {
    const c = await client(url); await c.notify();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "pick_device", arguments: { deviceId: "engine-a" } } });
    const pending = rawPost(url, c.sessionHeaders, request => { writing = request; request.write(body.slice(0, 10)); });
    await delay(30);
    handler.shutdown();
    writing!.end(body.slice(10));
    assert.equal((await pending).status, 503);
  } finally {
    writing?.destroy(); handler.shutdown(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("MCP explicit close of stale ownership never closes its successor", async () => {
  await withGateway(async url => {
    const c = await client(url); await c.notify();
    await c.tool("pick_device", { deviceId: "engine-a" });
    const prior = await status(url);
    const post = (path: string, body: unknown) => fetch(`${url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal((await post("/session/close", { sessionId: prior.sessionId })).status, 200);
    assert.equal((await post("/session/open", { sessionId: "successor" })).status, 200);
    assert.match((await c.tool("session_close", { deviceId: "engine-a" })).value, /^ENGINE_BUSY:/);
    assert.equal((await status(url)).sessionId, "successor");
  });
});
