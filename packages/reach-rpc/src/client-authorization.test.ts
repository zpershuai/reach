import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { createGateway } from "./gateway.js";
import { ClientAccess } from "./console-api/client-access.js";
import { ConsoleStore } from "./console-api/store.js";
import { HttpGatewayClient } from "./mcp/gateway.js";
import { McpServer } from "./mcp/server.js";
import { GrantStore } from "./grants.js";
import { fileURLToPath } from "node:url";
import { totp } from "./console-api/credentials.js";
import { ClientAuthorization } from "./client-authorization.js";
import type { EngineApi, EngineStatus } from "./mcp/in-process.js";

const owner = "c".repeat(48);
const engineTokens = { "engine-a": "e".repeat(48), "engine-b": "f".repeat(48) };

async function fixture(options: { realClock?: boolean; executorLifetime?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "reach-scoped-clients-"));
  let now = Date.now();
  const clock = () => options.realClock ? Date.now() : now;
  const store = new ConsoleStore(directory);
  const access = new ClientAccess(store, clock, () => {});
  const read = [{ engineId: "engine-a", workspace: "docs", read: true, write: false, execute: false }];
  const write = ["engine-a", "engine-b"].map(engineId => ({ engineId, workspace: "docs", read: true, write: true, execute: false }));
  const clients = {
    reader: access.create("Reader fixture", now + 60_000, read),
    other: access.create("Other reader fixture", now + 60_000, read),
    writer: access.create("Writer fixture", now + 60_000, write),
    otherWriter: access.create("Other writer fixture", now + 60_000, write),
    empty: access.create("Empty fixture", now + 60_000),
    executor: access.create("Executor fixture", now + (options.executorLifetime ?? 60_000), [{ engineId: "engine-a", workspace: "scripts", read: false, write: false, execute: true }]),
    otherExecutor: access.create("Other executor fixture", now + 60_000, [{ engineId: "engine-a", workspace: "scripts", read: false, write: false, execute: true }]),
  };
  access.close(); store.close();
  const gateway = createGateway({ logger: () => {}, now: clock,
    authentication: { controllerToken: owner, engineToken: engineTokens["engine-a"], engineId: "engine-a" },
    engines: [{ engineId: "engine-b", engineToken: engineTokens["engine-b"] }],
    console: { dataDir: directory, publicOrigin: "https://gateway.example.com", setupToken: "fixture-setup", trustedProxies: [], retentionDays: 30 },
  });
  gateway.listen(0, "127.0.0.1"); await once(gateway, "listening");
  const address = gateway.address(); assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const cookies = new Map<string, string>();
  let csrf = "";
  const consoleCall = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(`${url}/api/console/${path}`, { method, headers: {
      origin: "https://gateway.example.com", "content-type": "application/json", "x-csrf-token": csrf,
      cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(";")[0]; const separator = pair.indexOf("=");
      cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    const data = await response.json() as Record<string, any>;
    if (data.csrfToken) csrf = data.csrfToken;
    assert.equal(response.status, 200, JSON.stringify(data));
    return data;
  };
  const setup = async () => {
    await consoleCall("me");
    const enrollment = await consoleCall("setup", { token: "fixture-setup" });
    await consoleCall("setup", { token: "fixture-setup", password: "a long fixture password", code: totp(enrollment.secret, clock()) });
  };
  const sockets: WebSocket[] = [];
  const forwarded: Array<Record<string, any>> = [];
  const headers = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}`, "content-type": "application/json", "x-reach-client": "forged-owner-label" });
  const post = (token: string, path: string, body: unknown) => fetch(url + path, { method: "POST", headers: headers(token), body: JSON.stringify(body) });
  const status = async (token: string, engineId = "engine-a"): Promise<Record<string, any>> => (await post(token, `/session/status?engineId=${engineId}`, {})).json();
  const waitFor = async (check: () => Promise<boolean>) => {
    for (let attempt = 0; attempt < 500; attempt++) { if (await check()) return; await delay(5); }
    assert.fail("Fixture state did not converge");
  };
  const engine = async (engineId: keyof typeof engineTokens = "engine-a") => {
    const lease = await (await post(engineTokens[engineId], "/heartbeat", { device: { id: engineId, engineVersion: "1.2.3" } })).json() as { endpoint: string; token: string; sessionId: string };
    const socket = new WebSocket(`${url.replace("http:", "ws:")}${lease.endpoint}${lease.endpoint.includes("?") ? "&" : "?"}token=${lease.token}`);
    sockets.push(socket); await once(socket, "open");
    const tasks = new Map<string, Record<string, unknown>>();
    socket.on("message", data => {
      const message = JSON.parse(data.toString());
      if (message.type === "request") {
        forwarded.push(message);
        const method = message.method === "tool.call" ? message.params.name : message.method;
        const params = message.method === "tool.call" ? message.params.arguments : message.params;
        let result: Record<string, unknown> = { content: "fixture", revision: "a".repeat(64) };
        if (method === "process.run") {
          const processId = randomUUID();
          result = { processId, launchId: params.launchId, workspace: params.workspace, script: params.script, state: "running", startedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 60_000).toISOString(), endedAt: null, exitCode: null, signal: null, reason: null };
          tasks.set(processId, result);
        } else if (method === "process.list") result = { processes: [...tasks.values()], nextCursor: null };
        else if (method === "process.status" || method === "process.stop") result = tasks.get(params.processId) ?? [...tasks.values()].find(task => task.launchId === params.launchId) ?? {};
        else if (method === "process.logs") result = { records: [], nextCursor: "fixture", eof: false, truncated: false };
        socket.send(JSON.stringify({ type: "response", requestId: message.requestId, result }));
      } else if (message.type === "session.close") {
        socket.send(JSON.stringify({ type: "session.closed", sessionId: lease.sessionId, reason: "agent_requested" }));
        socket.close();
      }
    });
    socket.send(JSON.stringify({ type: "session.ready", protocol: "reach-rpc", version: "1.0", sessionId: lease.sessionId, engineId, engineVersion: "1.2.3",
      workspaces: ["docs", "private", "scripts"], processWorkspaces: ["scripts"], methods: ["fs.read", "fs.write", "fs.edit", "process.run", "process.status", "process.logs", "process.stop"] }));
    await waitFor(async () => (await status(owner, engineId)).status === "ready");
    return socket;
  };
  const rpc = (token: string, method: string, params: Record<string, unknown>, permission?: { grantId: string }, engineId = "engine-a") => post(token, `/session/rpc?engineId=${engineId}`, { requestId: randomUUID(), method, params, permission, principalId: "controller" });
  const mcp = async (token: string) => {
    const baseHeaders = { ...headers(token), accept: "application/json, text/event-stream" };
    const initialized = await fetch(url + "/mcp", { method: "POST", headers: baseHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "controller", version: "fixture" } } }) });
    assert.equal(initialized.status, 200, await initialized.clone().text());
    const sessionHeaders = { ...baseHeaders, "mcp-session-id": initialized.headers.get("mcp-session-id")!, "mcp-protocol-version": "2025-06-18" };
    let id = 1;
    const request = (method: string, params?: unknown) => fetch(url + "/mcp", { method: "POST", headers: sessionHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const notified = await fetch(url + "/mcp", { method: "POST", headers: sessionHeaders, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    assert.equal(notified.status, 202);
    return { request, tool: (name: string, args: unknown = {}) => request("tools/call", { name, arguments: args }), sessionHeaders };
  };
  return { directory, url, clients, forwarded, post, status, waitFor, engine, rpc, mcp, consoleCall, setup, advance: (ms: number) => { now += ms; },
    setPolicy: (id: string, permissions: unknown) => {
      const database = new ConsoleStore(directory); const manager = new ClientAccess(database, () => now, () => {});
      try { manager.setPolicy(id, permissions); } finally { manager.close(); database.close(); }
    },
    close: async () => {
      for (const socket of sockets) { if (socket.readyState === WebSocket.CLOSED) continue; const closed = once(socket, "close"); socket.close(); await closed; }
      await new Promise<void>(resolve => gateway.close(() => resolve())); rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("REST identity policy filters resources and rejects forged attribution, reads, writes and session adoption", async () => {
  const f = await fixture();
  try {
    const token = f.clients.reader.token;
    const hidden = await f.post(token, "/session/status?engineId=engine-b", {});
    const missing = await f.post(token, "/session/status?engineId=missing", {});
    assert.equal(hidden.status, 404); assert.equal(missing.status, 404);
    assert.deepEqual(await hidden.json(), await missing.json());
    assert.equal((await f.post(f.clients.empty.token, "/session/open", {})).status, 404);
    assert.equal((await f.post(token, "/grants", { workspace: "docs", path: "x.txt", methods: ["fs.write"] })).status, 403);
    assert.equal((await f.post(token, "/session/open", { principalId: "controller" })).status, 200);
    await f.engine();
    const status = await f.status(token);
    assert.deepEqual(status.workspaces, ["docs"]);
    assert.deepEqual(status.processWorkspaces, []);
    assert.deepEqual(status.methods, ["fs.read"]);
    for (const [method, params] of [["fs.read", { workspace: "docs", path: "x.txt" }], ["tool.call", { name: "fs.read", arguments: { workspace: "docs", path: "x.txt" } }]] as const) {
      const response = await f.rpc(token, method, params);
      assert.equal(response.status, 200); assert.equal((await response.json() as any).result.content, "fixture");
    }
    const before = f.forwarded.length;
    for (const [method, params, code] of [
      ["fs.read", { workspace: "private", path: "secret.txt" }, "PERMISSION_DENIED"],
      ["fs.list", { workspace: "private", path: ".", cursor: "foreign-cursor" }, "PERMISSION_DENIED"],
      ["fs.write", { workspace: "docs", path: "x.txt", content: "x" }, "PERMISSION_DENIED"],
      ["tool.call", { name: "tool.call", arguments: { name: "fs.write", arguments: {} } }, "INVALID_PARAMS"],
    ] as const) assert.equal((await (await f.rpc(token, method, params)).json() as any).error.code, code);
    const other = f.clients.other.token;
    assert.equal((await f.status(other)).sessionId, undefined);
    for (const path of ["/session/open", "/session/renew", "/session/close"]) assert.equal((await f.post(other, path, { sessionId: status.sessionId, principalId: f.clients.reader.client.id })).status, 409);
    assert.equal((await f.rpc(other, "fs.read", { workspace: "docs", path: "x.txt" })).status, 409);
    assert.equal(f.forwarded.length, before);
    assert.equal((await f.status(token)).status, "ready");
    f.advance(60_000);
    assert.equal((await f.post(token, "/session/status", {})).status, 401);
  } finally { await f.close(); }
});

test("MCP and the Connector HTTP client use the same authenticated resource and operation boundary", async () => {
  const f = await fixture();
  try {
    const token = f.clients.reader.token;
    const client = await f.mcp(token);
    const devices = await (await client.tool("list_devices")).json() as any;
    assert.deepEqual(JSON.parse(devices.result.content[0].text).devices.map((device: any) => device.id), ["engine-a"]);
    const tools = await (await client.request("tools/list")).json() as any;
    const names = tools.result.tools.map((tool: any) => tool.name) as string[];
    assert.ok(names.includes("fs_read"));
    assert.ok(!names.includes("fs_write") && !names.includes("process_run") && !names.includes("process_logs"));
    const hidden = await client.tool("list_workspaces", { deviceId: "engine-b" });
    const missing = await client.tool("list_workspaces", { deviceId: "missing" });
    assert.equal(hidden.status, 404); assert.equal(missing.status, 404);
    assert.equal((await hidden.json() as any).error.message, (await missing.json() as any).error.message);
    await client.tool("list_workspaces", { deviceId: "engine-a" }); await f.engine();
    const workspace = await (await client.tool("list_workspaces", { deviceId: "engine-a" })).json() as any;
    assert.deepEqual(JSON.parse(workspace.result.content[0].text).workspaces, ["docs"]);
    const read = await (await client.tool("fs_read", { deviceId: "engine-a", workspace: "docs", path: "x.txt", principalId: "controller" })).json() as any;
    assert.equal(JSON.parse(read.result.content[0].text).content, "fixture");
    const before = f.forwarded.length;
    const write = await (await client.tool("fs_write", { deviceId: "engine-a", workspace: "docs", path: "x.txt", content: "x", mode: "create" })).json() as any;
    assert.equal(write.result.isError, true); assert.equal(f.forwarded.length, before);
    const connector = new HttpGatewayClient({ id: "fixture", engineId: "engine-a", gatewayUrl: f.url, controllerToken: token }, 1000, 5);
    const denied = await connector.rpc("fs.read", { workspace: "private", path: "secret.txt" });
    assert.deepEqual(denied.error, { code: "PERMISSION_DENIED" });
    assert.equal(f.forwarded.length, before);
    const unauthorized = await fetch(f.url + "/mcp", { method: "GET", headers: { ...client.sessionHeaders, authorization: `Bearer ${f.clients.other.token}` } });
    assert.equal(unauthorized.status, 404);
  } finally { await f.close(); }
});

test("stdio MCP cannot turn a scoped bearer credential into Owner authority", async () => {
  const f = await fixture();
  const replies: Record<string, any>[] = [];
  const devices = [{ id: "fixture", engineId: "engine-a", gatewayUrl: f.url, controllerToken: f.clients.reader.token }, { id: "hidden", engineId: "engine-b", gatewayUrl: f.url, controllerToken: f.clients.reader.token }];
  const server = new McpServer({ devices, toolMode: "static", readyTimeoutMs: 2000, readyPollMs: 5, renewSkewMs: 60_000, requestTimeoutMs: 2000 }, message => replies.push(message));
  try {
    await server.receive({ jsonrpc: "2.0", id: 1, method: "initialize" });
    await server.receive({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "list_devices" } });
    assert.deepEqual(JSON.parse(replies.find(reply => reply.id === 10)!.result.content[0].text).devices, [{ id: "fixture" }]);
    assert.equal((await f.status(owner)).status, "none");
    await server.receive({ jsonrpc: "2.0", id: 11, method: "tools/list" });
    assert.ok(!replies.find(reply => reply.id === 11)!.result.tools.some((tool: any) => tool.name === "fs.write"));
    const read = server.receive({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fs.read", arguments: { deviceId: "fixture", workspace: "docs", path: "x.txt" } } });
    await f.waitFor(async () => (await f.status(owner)).status === "wanted");
    await f.engine(); await read;
    assert.equal(replies.find(reply => reply.id === 2)!.result.isError, undefined);
    await server.receive({ jsonrpc: "2.0", id: 12, method: "tools/list" });
    const names = replies.find(reply => reply.id === 12)!.result.tools.map((tool: any) => tool.name) as string[];
    assert.ok(names.includes("fs.read") && !names.includes("fs.write") && !names.includes("process.run"));
    const before = f.forwarded.length;
    await server.receive({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fs.write", arguments: { deviceId: "fixture", workspace: "docs", path: "x.txt", content: "x", mode: "create" } } });
    assert.equal(replies.find(reply => reply.id === 3)!.result.isError, true);
    assert.equal(f.forwarded.length, before);
  } finally { await server.shutdown().catch(() => {}); await f.close(); }
});

test("failed client cleanup retains ownership until retry succeeds", () => {
  const authorization = new ClientAuthorization(undefined, owner, undefined, undefined, () => {});
  let state: EngineStatus = { status: "none", engineVersion: null };
  let fail = true;
  let revoked = "";
  const api: EngineApi = {
    status: () => state,
    open: sessionId => { state = { status: "ready", sessionId, engineVersion: null }; return { statusCode: 200, payload: { sessionId } }; },
    close: () => { if (fail) throw new Error("fixture cleanup failure"); state = { status: "none", engineVersion: null }; return { statusCode: 200, payload: {} }; },
    renew: () => ({ statusCode: 200, payload: {} }), grant: () => ({ statusCode: 200, payload: {} }),
    rpc: async () => ({ statusCode: 200, payload: {} }), revokePrincipal: id => { revoked = id; },
  };
  const principal = authorization.authenticate(`Bearer ${owner}`, false)!;
  const facade = authorization.bind("engine-a", api, principal.id);
  try {
    assert.equal(authorization.run(principal, () => facade.open("fixture-session")).statusCode, 200);
    authorization.invalidate(principal.id, new Map([["engine-a", api]]));
    assert.equal(revoked, principal.id);
    assert.equal(authorization.run(principal, () => facade.open("replacement")).statusCode, 409);
    assert.equal(authorization.run(principal, () => facade.renew("fixture-session")).statusCode, 403);
    fail = false;
    authorization.retryCleanup(); authorization.retryCleanup();
    assert.equal(authorization.run(principal, () => facade.open("replacement")).statusCode, 200);
  } finally { authorization.close(); }
});

for (const action of ["revoke", "rotate", "reduce", "expire"] as const) {
  test(`real Engine drains ordinary descendants on client ${action} without another client request`, { timeout: 20_000 }, async () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const binary = join(root, "target/debug/engine");
    if (!existsSync(binary)) execFileSync("cargo", ["build", "--quiet", "--locked", "-p", "reach-rpc", "--bin", "engine"], { cwd: root });
    const f = await fixture({ realClock: true, executorLifetime: action === "expire" ? 3500 : 60_000 });
    let child: ReturnType<typeof spawn> | undefined;
    let pids: number[] = [];
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      await f.setup();
      const workspace = join(f.directory, "workspace"); mkdirSync(workspace);
      const pidFile = join(workspace, "pids.json");
      // Publish the complete PID list atomically. File existence must not let
      // the observer read between create/truncate and the JSON payload write.
      writeFileSync(join(workspace, "job.cjs"), "const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'}); const fs = require('node:fs'); fs.writeFileSync('pids.json.tmp', JSON.stringify([process.pid, child.pid])); fs.renameSync('pids.json.tmp', 'pids.json'); setInterval(() => {}, 1000);\n");
      const token = f.clients.executor.token;
      await f.post(token, "/session/open", {});
      child = spawn(binary, [f.url], { env: { PATH: process.env.PATH, HOME: f.directory, REACH_ENGINE_ID: "engine-a", REACH_ENGINE_TOKEN: engineTokens["engine-a"], REACH_WORKSPACE_ROOTS: `scripts:${workspace}`, REACH_PROCESS_WORKSPACES: "scripts", REACH_PROCESS_NODE_BIN: process.execPath }, stdio: "ignore" });
      await once(child, "spawn");
      await f.waitFor(async () => (await f.status(token)).status === "ready");
      await f.post(f.clients.writer.token, "/session/open?engineId=engine-b", {}); await f.engine("engine-b");
      const session = await f.status(token);
      const run = { workspace: "scripts", script: "job.cjs", launchId: `drain-${action}` };
      const grant = await (await f.post(token, "/grants", { kind: "execute", sessionId: session.sessionId, ...run })).json() as { grantId: string };
      const result = await (await f.rpc(token, "process.run", run, grant)).json() as any;
      assert.ok(result.result?.processId, JSON.stringify(result));
      await f.waitFor(async () => existsSync(pidFile));
      pids = JSON.parse(readFileSync(pidFile, "utf8")); assert.ok(pids.every(alive));
      const path = `access-clients/${encodeURIComponent(f.clients.executor.client.id)}`;
      if (action === "revoke") await f.consoleCall(path, undefined, "DELETE");
      if (action === "rotate") await f.consoleCall(path + "/rotate", { expiresAt: Date.now() + 60_000 });
      if (action === "reduce") await f.consoleCall(path + "/policy", { permissions: [] }, "PATCH");
      // Only the Owner observes cleanup; the revoked/expired client sends no new request.
      for (let attempt = 0; attempt < 2000 && (pids.some(alive) || (await f.status(owner)).status !== "none"); attempt++) await delay(5);
      assert.ok(pids.every(pid => !alive(pid)), "ordinary process group descendants must terminate");
      assert.equal((await f.status(owner)).status, "none");
      assert.equal((await f.status(f.clients.writer.token, "engine-b")).status, "ready");
      if (action !== "reduce") assert.equal((await f.post(token, "/session/status", {})).status, 401);
    } finally {
      for (const pid of pids) if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit"); const fallback = setTimeout(() => child!.kill("SIGKILL"), 2000); fallback.unref();
        child.kill("SIGTERM"); await exited; clearTimeout(fallback);
      }
      await f.close();
    }
  });
}

test("filesystem grants cannot cross principal, Engine or policy revision boundaries", async () => {
  const f = await fixture();
  try {
    const first = f.clients.writer.token;
    const second = f.clients.otherWriter.token;
    await f.post(first, "/session/open", {}); await f.engine();
    const grantBody = { workspace: "docs", path: "x.txt", methods: ["fs.write"] };
    const grant = await (await f.post(first, "/grants", grantBody)).json() as { grantId: string };
    await f.post(first, "/session/close", {}); await f.waitFor(async () => (await f.status(owner)).status === "none");
    await f.post(second, "/session/open", {}); await f.engine();
    const params = { workspace: "docs", path: "x.txt", content: "x", mode: "create" };
    const before = f.forwarded.length;
    assert.equal((await (await f.rpc(second, "fs.write", params, grant)).json() as any).error.code, "PERMISSION_DENIED");
    assert.equal(f.forwarded.length, before);
    const ownGrant = await (await f.post(second, "/grants", grantBody)).json() as { grantId: string };
    assert.ok((await (await f.rpc(second, "fs.write", params, ownGrant)).json() as any).result);
    await f.post(second, "/session/open?engineId=engine-b", {}); await f.engine("engine-b");
    assert.equal((await (await f.rpc(second, "fs.write", params, ownGrant, "engine-b")).json() as any).error.code, "PERMISSION_DENIED");
    f.setPolicy(f.clients.otherWriter.client.id, ["engine-a", "engine-b"].map(engineId => ({ engineId, workspace: "docs", read: true, write: true, execute: false })));
    assert.equal((await (await f.rpc(second, "fs.write", params, ownGrant)).json() as any).error.code, "PERMISSION_DENIED");
    const freshGrant = await (await f.post(second, "/grants", grantBody)).json() as { grantId: string };
    const pendingBody = JSON.stringify({ requestId: randomUUID(), method: "fs.write", params, permission: freshGrant });
    let sendRemaining: () => void = () => {};
    const queued = new Promise<{ status: number; payload: any }>((resolve, reject) => {
      const request = httpRequest(f.url + "/session/rpc", { method: "POST", headers: { authorization: `Bearer ${second}`, "content-type": "application/json" } }, response => {
        let text = "";
        response.on("data", chunk => { text += chunk; });
        response.on("end", () => resolve({ status: response.statusCode!, payload: JSON.parse(text) }));
      });
      request.on("error", reject);
      const split = Math.floor(pendingBody.length / 2);
      request.write(pendingBody.slice(0, split));
      sendRemaining = () => request.end(pendingBody.slice(split));
    });
    await delay(20);
    f.setPolicy(f.clients.otherWriter.client.id, [{ engineId: "engine-a", workspace: "docs", read: true, write: false, execute: false }]);
    const after = f.forwarded.length;
    sendRemaining();
    const deniedQueued = await queued;
    assert.equal(deniedQueued.status, 200);
    assert.equal(deniedQueued.payload.error.code, "PERMISSION_DENIED");
    assert.equal((await (await f.rpc(second, "fs.write", params, ownGrant)).json() as any).error.code, "PERMISSION_DENIED");
    assert.equal(f.forwarded.length, after);
  } finally { await f.close(); }
});

test("all grant classes bind immutable principal Engine and policy authority and revoke independently", () => {
  let now = 1000;
  const grants = new GrantStore(() => now);
  const authority = { principalId: "client:fixture-a", engineId: "engine-a", policyRevision: 1 };
  const original = { ...authority };
  const write = grants.issue("docs", "x.txt", ["fs.write"], authority);
  const execute = grants.issueProcess({ kind: "execute", sessionId: "session-a", workspace: "scripts", script: "job.cjs", launchId: "launch-a" }, authority);
  const control = grants.issueProcess({ kind: "control", sessionId: "session-a", processId: "process-a" }, authority);
  authority.policyRevision = 99;
  const runParams = { workspace: "scripts", script: "job.cjs", launchId: "launch-a" };
  assert.equal(grants.matches(write.grantId, "fs.write", "docs", "x.txt", original), true);
  assert.equal(grants.matchesProcess(execute.grantId, "session-a", "process.run", runParams, original), "execute");
  assert.equal(grants.matchesProcess(control.grantId, "session-a", "process.stop", { processId: "process-a" }, original), "control");
  assert.equal(grants.matchesProcess(write.grantId, "session-a", "process.run", runParams, original), undefined);
  assert.equal(grants.matches(execute.grantId, "fs.write", "docs", "x.txt", original), false);
  assert.equal(grants.matchesProcess(control.grantId, "session-a", "process.run", runParams, original), undefined);
  assert.equal(grants.matches("forged-grant", "fs.write", "docs", "x.txt", original), false);
  for (const wrong of [undefined, { ...original, principalId: "client:fixture-b" }, { ...original, engineId: "engine-b" }, { ...original, policyRevision: 2 }]) {
    assert.equal(grants.matches(write.grantId, "fs.write", "docs", "x.txt", wrong), false);
    assert.equal(grants.matchesProcess(execute.grantId, "session-a", "process.run", runParams, wrong), undefined);
    assert.equal(grants.matchesProcess(control.grantId, "session-a", "process.stop", { processId: "process-a" }, wrong), undefined);
  }
  const other = { ...original, principalId: "client:fixture-b" };
  const otherGrant = grants.issue("docs", "x.txt", ["fs.write"], other);
  grants.revokePrincipal(original.principalId);
  assert.equal(grants.matches(write.grantId, "fs.write", "docs", "x.txt", original), false);
  assert.equal(grants.matchesProcess(execute.grantId, "session-a", "process.run", runParams, original), undefined);
  assert.equal(grants.matches(otherGrant.grantId, "fs.write", "docs", "x.txt", other), true);
  now += 300_000;
  assert.equal(grants.matches(otherGrant.grantId, "fs.write", "docs", "x.txt", other), false);
});

test("process observation and control require the principal's session and executable task workspace", async () => {
  const f = await fixture();
  try {
    const token = f.clients.executor.token;
    await f.post(token, "/session/open", {}); await f.engine();
    const status = await f.status(token);
    const run = { workspace: "scripts", script: "job.cjs", launchId: "launch-fixture" };
    assert.equal((await (await f.rpc(token, "process.run", run)).json() as any).error.code, "PERMISSION_DENIED");
    const grant = await (await f.post(token, "/grants", { kind: "execute", sessionId: status.sessionId, ...run })).json() as { grantId: string };
    const launched = await (await f.rpc(token, "process.run", run, grant)).json() as any;
    const processId = launched.result.processId as string;
    assert.ok(processId);
    assert.deepEqual(f.forwarded.at(-1)!.permission, { grantId: grant.grantId, kind: "execute" });
    assert.equal((await (await f.rpc(token, "process.status", { launchId: run.launchId })).json() as any).result.processId, processId);
    assert.equal((await (await f.rpc(token, "process.logs", { processId })).json() as any).result.eof, false);
    const before = f.forwarded.length;
    for (const method of ["process.status", "process.logs", "process.stop"]) {
      assert.equal((await (await f.rpc(token, method, { processId: "foreign-process" })).json() as any).error.code, "PROCESS_NOT_FOUND");
      assert.equal((await f.rpc(f.clients.otherExecutor.token, method, { processId })).status, 409);
    }
    assert.equal((await (await f.rpc(token, "process.list", { workspace: "private", cursor: "foreign-cursor" })).json() as any).error.code, "PERMISSION_DENIED");
    assert.equal((await f.post(token, "/grants", { kind: "control", sessionId: status.sessionId, processId: "foreign-process" })).status, 403);
    assert.equal(f.forwarded.length, before);
    assert.equal((await (await f.rpc(token, "process.stop", { processId })).json() as any).error.code, "PERMISSION_DENIED");
    const control = await (await f.post(token, "/grants", { kind: "control", sessionId: status.sessionId, processId })).json() as { grantId: string };
    assert.equal((await (await f.rpc(token, "process.stop", { processId }, control)).json() as any).result.processId, processId);
    f.setPolicy(f.clients.executor.client.id, [{ engineId: "engine-a", workspace: "docs", read: false, write: false, execute: true }]);
    const listed = await (await f.rpc(token, "process.list", { maxEntries: 1 })).json() as any;
    assert.deepEqual(listed.result.processes, []);
    assert.ok(!JSON.stringify(listed).includes(processId));
  } finally { await f.close(); }
});

test("a scoped Gateway execution grant cannot enable a real Engine's locally disabled workspace", { timeout: 30000 }, async () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const binary = join(root, "target/debug/engine");
  if (!existsSync(binary)) execFileSync("cargo", ["build", "--quiet", "--locked", "-p", "reach-rpc", "--bin", "engine"], { cwd: root });
  const f = await fixture();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const workspace = join(f.directory, "workspace"); mkdirSync(workspace);
    const sentinel = join(workspace, "executed.txt");
    writeFileSync(join(workspace, "job.cjs"), "require('node:fs').writeFileSync('executed.txt', 'must not run');\n");
    const token = f.clients.executor.token;
    await f.post(token, "/session/open", {});
    child = spawn(binary, [f.url], { env: { PATH: process.env.PATH, HOME: f.directory, REACH_ENGINE_ID: "engine-a", REACH_ENGINE_TOKEN: engineTokens["engine-a"], REACH_WORKSPACE_ROOTS: `scripts:${workspace}`, REACH_PROCESS_WORKSPACES: "" }, stdio: "ignore" });
    await once(child, "spawn");
    await f.waitFor(async () => (await f.status(token)).status === "ready");
    const status = await f.status(token);
    assert.deepEqual(status.processWorkspaces, []);
    const run = { workspace: "scripts", script: "job.cjs", launchId: "disabled-fixture" };
    const grant = await (await f.post(token, "/grants", { kind: "execute", sessionId: status.sessionId, ...run })).json() as { grantId: string };
    const result = await (await f.rpc(token, "process.run", run, grant)).json() as any;
    assert.equal(result.error.code, "PROCESS_EXECUTION_DISABLED");
    assert.equal(existsSync(sentinel), false);
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGTERM");
      await Promise.race([exited, delay(2000)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    }
    await f.close();
  }
});
