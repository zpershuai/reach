import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const deployment = JSON.parse(await readFile(process.argv[2] ?? ".reach/deployment.json", "utf8"));
const base = new URL(deployment.gatewayUrl);
assert.ok(base.protocol === "https:" || (base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)), "Use HTTPS for a remote Gateway");
assert.ok(!base.username && !base.password && !base.search && !base.hash && base.pathname === "/", "Gateway URL must be an origin without credentials or path");
const url = base.origin;
const deviceId = deployment.engineId;
assert.ok(typeof deviceId === "string" && deviceId.length, "engineId is required");
assert.ok(typeof deployment.controllerToken === "string" && deployment.controllerToken.length >= 32, "Controller token is required");
const headers = { authorization: `Bearer ${deployment.controllerToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
if (deployment.mcpOrigin !== undefined) {
  assert.equal(typeof deployment.mcpOrigin, "string", "mcpOrigin must be an exact HTTP(S) Origin");
  const origin = new URL(deployment.mcpOrigin);
  assert.ok(["https:", "http:"].includes(origin.protocol) && origin.origin === deployment.mcpOrigin, "mcpOrigin must be an exact HTTP(S) Origin without path, credentials, query or fragment");
  headers.origin = origin.origin;
}
let sequence = 0;
const init = () => ({ jsonrpc: "2.0", id: ++sequence, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "reach-http-verifier", version: "1" } } });
const fetchMcp = (method, body, sessionHeaders = headers) => fetch(`${url}/mcp`, {
  method, headers: sessionHeaders, redirect: "error", signal: AbortSignal.timeout(30_000),
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

async function connect() {
  const response = await fetchMcp("POST", init());
  assert.equal(response.status, 200, response.status === 403
    ? "MCP Origin rejected: configure REACH_MCP_ALLOWED_ORIGINS with the actual client's exact Origin, then recreate the Gateway container"
    : "MCP initialize must succeed (404 means the deployed Gateway lacks /mcp)");
  const initialized = await response.json();
  assert.equal(initialized.result.serverInfo.name, "reach-mcp");
  const id = response.headers.get("mcp-session-id");
  assert.ok(id, "Initialize must return Mcp-Session-Id");
  const sessionHeaders = { ...headers, "mcp-session-id": id, "mcp-protocol-version": initialized.result.protocolVersion };
  const ack = await fetchMcp("POST", { jsonrpc: "2.0", method: "notifications/initialized" }, sessionHeaders);
  assert.equal(ack.status, 202); assert.equal(await ack.text(), "");
  const request = async (method, params) => {
    const response = await fetchMcp("POST", { jsonrpc: "2.0", id: ++sequence, method, params }, sessionHeaders);
    assert.equal(response.status, 200, `MCP ${method} must succeed`);
    const reply = await response.json();
    assert.ok(!reply.error, `MCP ${method} returned a protocol error`);
    return reply.result;
  };
  const tool = async (name, args = {}, allowError = false) => {
    const result = await request("tools/call", { name, arguments: { deviceId, ...args } });
    if (allowError && result.isError) return result.content[0].text;
    assert.ok(!result.isError, `${name}: ${result.content[0].text}`);
    return JSON.parse(result.content[0].text);
  };
  return { request, tool, close: () => fetchMcp("DELETE", undefined, sessionHeaders), sessionHeaders };
}

const unauthorized = await fetchMcp("POST", init(), { "content-type": "application/json", accept: headers.accept });
assert.equal(unauthorized.status, 401);
const client = await connect();
const results = [];
const probe = `deployment-tests/${randomUUID()}.txt`;
try {
  assert.equal((await fetchMcp("GET", undefined, client.sessionHeaders)).status, 405);
  const tools = (await client.request("tools/list", {})).tools;
  assert.equal(tools.length, 17);
  for (const tool of tools) {
    assert.match(tool.name, /^[a-zA-Z0-9_-]{1,64}$/);
    if (tool.name.startsWith("fs_") || tool.name === "session_close") assert.ok(tool.inputSchema.required.includes("deviceId"));
  }
  assert.ok((await client.tool("list_devices")).devices.some((device) => device.id === deviceId));
  results.push("auth, initialize, notification ack, static tools and registered devices");
  const started = Date.now();
  await client.tool("pick_device");
  assert.ok(Date.now() - started < 30_000, "Cold-start call must fit one HTTP response budget");
  const deadline = Date.now() + 150_000;
  while (true) {
    const status = await client.tool("device_status");
    if (status.status === "ready" && status.owned) break;
    assert.ok(Date.now() < deadline, "Engine did not become ready within 150 seconds");
    await delay(status.retryAfterMs ?? 1000);
  }
  const competitor = await connect();
  try { assert.match(await competitor.tool("pick_device", {}, true), /^ENGINE_BUSY:/); }
  finally { assert.equal((await competitor.close()).status, 200); }
  results.push("bounded cold start, readiness polling and competing-owner rejection");
  const args = { workspace: "default", path: probe };
  await client.tool("fs_write", { ...args, content: "Reach HTTP MCP verified", mode: "create" });
  const read = await client.tool("fs_read", args);
  assert.equal(read.content, "Reach HTTP MCP verified"); assert.match(read.revision, /^[a-f0-9]{64}$/);
  await client.tool("fs_edit", { ...args, oldString: "verified", newString: "edit verified", ifMatch: read.revision });
  assert.match(await client.tool("fs_edit", { ...args, oldString: "edit verified", newString: "wrong", ifMatch: read.revision }, true), /^REVISION_CONFLICT:/);
  assert.equal((await client.tool("fs_read", args)).content, "Reach HTTP MCP edit verified");
  results.push("write, read, revision-safe edit and stale-revision rejection");
} finally {
  assert.equal((await client.close()).status, 200, "DELETE must drain owned Engine sessions");
}
const closed = await fetch(`${url}/session/status?engineId=${encodeURIComponent(deviceId)}`, { headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
assert.equal(closed.status, 200);
assert.equal((await closed.json()).status, "none");
assert.equal((await fetchMcp("POST", { jsonrpc: "2.0", id: ++sequence, method: "ping" }, client.sessionHeaders)).status, 404);
results.push("DELETE drain and expired-id rejection");
await mkdir(".reach", { recursive: true, mode: 0o700 });
await writeFile(".reach/mcp-http-verification.json", JSON.stringify({ checkedAt: new Date().toISOString(), gatewayUrl: url, mcpOrigin: deployment.mcpOrigin ?? null, deviceId, probe, results }, null, 2) + "\n", { mode: 0o600 });
console.log("PASS remote HTTP MCP authentication, tools, ownership, filesystem revisions and cleanup");
