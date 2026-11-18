import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createGateway } from "../gateway.js";
import { totp } from "./credentials.js";
import { ConsoleStore } from "./store.js";
import { AuthRateLimiter, PeerResolver } from "./auth.js";
import type { IncomingMessage } from "node:http";
import { execFileSync, spawn } from "node:child_process";

async function fixture(setupToken: string | undefined = "test-setup-token") {
  const directory = mkdtempSync(join(tmpdir(), "reach-admin-"));
  let now = Date.now();
  const logs: string[] = [];
  const origin = "https://gateway.example.com";
  const controllerToken = "c".repeat(48);
  const gateway = createGateway({ logger: message => logs.push(message), now: () => now,
    heartbeatIntervalSeconds: 1,
    authentication: { controllerToken, engineToken: "e".repeat(48), engineId: "engine-a" },
    console: { dataDir: directory, publicOrigin: origin, setupToken, trustedProxies: [], retentionDays: 30 },
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const address = gateway.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  let cookies = new Map<string, string>();
  let csrfToken = "";
  const call = async (path: string, body?: unknown, headers: Record<string, string> = {}, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(`${base}/api/console/${path}`, { method, headers: {
      origin, "content-type": "application/json", "x-csrf-token": csrfToken, cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; "), ...headers,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(";")[0];
      const separator = pair.indexOf("=");
      cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    const data = await response.json() as Record<string, any>;
    if (data.csrfToken) csrfToken = data.csrfToken;
    return { response, data };
  };
  const setup = async (token = setupToken!) => {
    await call("me");
    const created = await call("setup", { token, username: "owner", password: "a long owner password" });
    assert.equal(created.response.status, 200, JSON.stringify(created.data));
    return created;
  };
  /** Enrols the signed-in user's authenticator and returns its secret and recovery codes. */
  const enableTotp = async () => {
    const begun = await call("account/totp/begin", {});
    assert.equal(begun.response.status, 200, JSON.stringify(begun.data));
    const secret = begun.data.secret as string;
    const confirmed = await call("account/totp/confirm", { code: totp(secret, now) });
    assert.equal(confirmed.response.status, 200, JSON.stringify(confirmed.data));
    return { secret, recoveryCodes: confirmed.data.recoveryCodes as string[] };
  };
  /** Signs out and signs in again as another account. */
  const signInAs = async (username: string, password: string, code?: string) => {
    cookies = new Map(); csrfToken = "";
    await call("me");
    return call("login", { username, password, ...(code ? { code } : {}) });
  };
  return {
    gateway, base, directory, logs, origin, controllerToken, call, setup, enableTotp, signInAs,
    cookies: () => new Map(cookies), reset: () => { cookies = new Map(); csrfToken = ""; },
    advance: (ms: number) => { now += ms; }, now: () => now,
    close: async () => { await new Promise<void>(resolve => gateway.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); },
  };
}

test("setup requires its token, creates an admin without TOTP, hashes sessions, and refuses a second setup", async () => {
  const f = await fixture();
  try {
    await f.call("me");
    assert.equal((await f.call("setup", { token: "wrong", username: "owner", password: "a long owner password" })).response.status, 403);
    assert.equal((await f.call("setup", { token: "test-setup-token", username: "x", password: "a long owner password" })).data.code, "USERNAME_INVALID");
    assert.equal((await f.call("setup", { token: "test-setup-token", username: "owner", password: "short" })).data.code, "PASSWORD_LENGTH");
    const setup = await f.setup();
    assert.deepEqual(setup.data.user, { id: 1, username: "owner", role: "admin", totpEnabled: false });
    assert.ok(!("recoveryCodes" in setup.data) && !("secret" in setup.data));
    const sessionCookie = setup.response.headers.getSetCookie().find(value => value.startsWith("reach_console="))!;
    for (const attribute of ["HttpOnly", "SameSite=Strict", "Path=/", "Secure"]) assert.ok(sessionCookie.includes(attribute));
    const store = new ConsoleStore(f.directory);
    try {
      const row = store.db.prepare("SELECT * FROM console_sessions").get()!;
      assert.notEqual(row.digest, f.cookies().get("reach_console"));
      assert.equal(store.db.prepare("SELECT count(*) AS n FROM recovery_codes").get()!.n, 0);
    } finally { store.close(); }
    const me = await f.call("me");
    assert.equal(me.data.authenticated, true);
    assert.equal(me.data.user.username, "owner");
    assert.equal((await f.call("setup", { token: "test-setup-token", username: "second", password: "a long owner password" })).response.status, 409);
    const snapshot = await f.call("snapshot");
    assert.ok(snapshot.data.gateway.warningDetails.some((warning: { code: string }) => warning.code === "ADMIN_WITHOUT_TOTP"));
    await f.enableTotp();
    assert.ok(!(await f.call("snapshot")).data.gateway.warningDetails.some((warning: { code: string }) => warning.code === "ADMIN_WITHOUT_TOTP"));
  } finally { await f.close(); }
});

test("generated setup tokens use a private file, never logs, and disappear after setup", async () => {
  const f = await fixture("");
  try {
    const path = join(f.directory, "admin-setup-token");
    const token = readFileSync(path, "utf8").trim();
    assert.equal(token.length, 48);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.ok(!f.logs.join("\n").includes(token));
    assert.equal((await f.call("setup", { token: "0".repeat(48) })).response.status, 403, "previous log-only bootstrap credentials are not accepted");
    await f.setup(token);
    assert.equal(existsSync(path), false);
    assert.equal((await f.call("setup", { token })).response.status, 409);
  } finally { await f.close(); }
});

test("credential failures are generic, TOTP is asked only after a correct password, and codes cannot be replayed", async () => {
  const f = await fixture();
  try {
    await f.setup();
    const { secret, recoveryCodes } = await f.enableTotp();
    const oldCookie = f.cookies().get("reach_console")!;
    await f.call("logout", {});
    assert.equal((await f.call("engines", undefined, { cookie: `reach_console=${oldCookie}` })).response.status, 401);
    await f.call("me");
    f.advance(30_000);
    const code = totp(secret, f.now());
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
    const wrongPassword = await f.call("login", { username: "owner", password: "wrong password", code });
    const wrongCode = await f.call("login", { username: "owner", password: "a long owner password", code: wrong });
    const unknownUser = await f.call("login", { username: "nobody", password: "a long owner password", code });
    assert.equal(wrongPassword.response.status, 401);
    assert.equal(wrongPassword.data.code, "INVALID_CREDENTIALS");
    assert.equal(wrongPassword.data.error, "Invalid credentials");
    assert.deepEqual(wrongPassword.data, wrongCode.data);
    assert.deepEqual(wrongPassword.data, unknownUser.data);
    const missingCode = await f.call("login", { username: "OWNER", password: "a long owner password" });
    assert.equal(missingCode.response.status, 401);
    assert.equal(missingCode.data.code, "TOTP_REQUIRED");
    assert.ok(!missingCode.response.headers.getSetCookie().some(value => value.startsWith("reach_console=")));
    assert.equal((await f.call("login", { username: "owner", password: "a long owner password", code })).response.status, 200);
    await f.call("logout", {});
    await f.call("me");
    assert.equal((await f.call("login", { username: "owner", password: "a long owner password", code })).response.status, 401);
    assert.equal((await f.call("login", { username: "owner", password: "a long owner password", code: recoveryCodes[0] })).response.status, 200);
    const events = f.gateway.events!.replay(0);
    for (const action of ["admin.setup", "admin.login", "admin.logout", "account.totp.enable"]) assert.ok(events.some(event => event.action?.startsWith(action)), action);
    const login = events.find(event => event.action === "admin.login")!;
    assert.deepEqual(login.caller, { type: "console", label: "owner", verified: true });
    assert.equal(events.filter(event => event.type === "auth.failed").length >= 1, true);
  } finally { await f.close(); }
});

test("sensitive mutations require reauthentication after ten minutes", async () => {
  const f = await fixture();
  try {
    await f.setup();
    assert.equal((await f.call("engines", { id: "engine-b", displayName: "Device B" })).response.status, 201);
    f.advance(10 * 60_000);
    const stale = await f.call("engines/engine-b", {}, {}, "DELETE");
    assert.equal(stale.response.status, 403);
    assert.equal(stale.data.code, "REAUTH_REQUIRED");
    assert.ok(f.gateway.registry.engines.has("engine-b"));
    assert.equal((await f.call("settings", { retentionDays: 90 }, {}, "PATCH")).response.status, 403);
    assert.equal((await f.call("reauth", { password: "a long owner password" })).response.status, 200);
    assert.equal((await f.call("engines/engine-b", {}, {}, "DELETE")).response.status, 200);
    assert.equal((await f.call("settings", { retentionDays: 90 }, {}, "PATCH")).response.status, 200);
    assert.equal((await f.call("settings")).data.retentionDays, 90);
  } finally { await f.close(); }
});

test("access-client management protects authority, returns secrets once and rejects partial policy writes", async () => {
  const f = await fixture();
  try {
    await f.setup();
    const permissions = [{ engineId: "engine-a", workspace: "docs", read: true, write: false, execute: false }];
    const input = { name: "Scoped fixture", expiresAt: f.now() + 3_600_000, permissions };
    const created = await f.call("access-clients", input);
    assert.equal(created.response.status, 201);
    assert.match(created.data.token, /^reach_ct_[A-Za-z0-9_-]{43}$/);
    const id = created.data.client.id as string;
    const path = `access-clients/${encodeURIComponent(id)}`;
    const listed = await f.call("access-clients");
    assert.ok(!JSON.stringify(listed.data).includes(created.data.token));
    assert.ok(!JSON.stringify(listed.data).includes("digest"));
    const detail = await f.call(path);
    assert.deepEqual(detail.data.client.permissions, permissions);
    assert.ok(!("token" in detail.data));
    const before = detail.data.client;
    const rejectedHeaders: Record<string, string>[] = [{ origin: "https://foreign.example.com" }, { "x-csrf-token": "wrong" }];
    for (const headers of rejectedHeaders) {
      assert.equal((await f.call(`${path}/policy`, { permissions: [] }, headers, "PATCH")).response.status, 403);
    }
    assert.equal((await f.call(`${path}/policy`, { permissions: [...permissions, ...permissions] }, {}, "PATCH")).response.status, 400);
    assert.deepEqual((await f.call(path)).data.client, before);
    const count = listed.data.clients.length;
    assert.equal((await f.call("access-clients", { ...input, legacyGlobal: true })).response.status, 400);
    assert.equal((await f.call("access-clients", { ...input, permissions: [{ ...permissions[0], engineId: "*" }] })).response.status, 400);
    assert.equal((await f.call("access-clients", { ...input, permissions: null })).response.status, 400);
    assert.equal((await f.call("access-clients", { ...input, expiresAt: f.now() })).response.status, 400);
    assert.equal((await f.call(`${path}/review-global`, { confirm: true })).response.status, 409);
    assert.equal((await f.call("access-clients")).data.clients.length, count);
    for (const token of [f.controllerToken, "e".repeat(48), created.data.token]) {
      const response = await fetch(`${f.base}/api/console/access-clients`, { method: "POST", headers: { authorization: `Bearer ${token}`, origin: f.origin, "content-type": "application/json" }, body: JSON.stringify(input) });
      assert.equal(response.status, 401);
    }
    f.advance(10 * 60_000);
    assert.equal((await f.call(`${path}/rotate`, { expiresAt: f.now() + 3_600_000 })).response.status, 403);
    assert.deepEqual((await f.call(path)).data.client, before);
    assert.equal((await f.call("reauth", { password: "a long owner password" })).response.status, 200);
    const rotated = await f.call(`${path}/rotate`, { expiresAt: f.now() + 3_600_000 });
    assert.equal(rotated.response.status, 200);
    assert.notEqual(rotated.data.token, created.data.token);
    assert.equal((await f.call(`${path}/policy`, { permissions: [] }, {}, "PATCH")).response.status, 200);
    assert.equal((await f.call(path, {}, {}, "DELETE")).response.status, 200);
    assert.equal((await f.call(path)).data.client.revokedAt, f.now());
    const actions = f.gateway.events!.replay(0).filter(event => event.type === "admin.action").map(event => event.action);
    for (const action of ["create", "rotate", "policy", "revoke"]) assert.ok(actions.includes(`client.${action}:${id}`));
    assert.ok(!JSON.stringify(f.logs).includes(created.data.token));
  } finally { await f.close(); }
});

test("console end-to-end: setup, enrollment, real Engine reads and writes, SSE, audit, export and disconnect", { timeout: 30_000 }, async () => {
  execFileSync("cargo", ["build", "--quiet", "--locked", "-p", "reach-rpc", "--bin", "engine"], { cwd: new URL("../../../../", import.meta.url) });
  const f = await fixture();
  let engine: ReturnType<typeof spawn> | undefined;
  const abort = new AbortController();
  let streamReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    await f.setup();
    const enrolled = await f.call("engines", { id: "engine-b", displayName: "Device B" });
    assert.equal(enrolled.response.status, 201);
    const workspace = join(f.directory, "workspace");
    mkdirSync(workspace);
    const outside = join(f.directory, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(workspace, "escape"));
    writeFileSync(join(workspace, "note.txt"), "local integration fixture");
    engine = spawn(new URL("../../../../target/debug/engine", import.meta.url).pathname, [], {
      env: { ...process.env, REACH_GATEWAY_URL: f.base, REACH_ENGINE_ID: "engine-b", REACH_ENGINE_TOKEN: enrolled.data.token, REACH_WORKSPACE_ROOTS: `default:${workspace}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    engine.stdout!.on("data", chunk => { output += chunk; });
    engine.stderr!.on("data", chunk => { output += chunk; });
    for (let attempt = 0; attempt < 600 && f.gateway.registry.enrollmentStatus("engine-b") !== "connected"; attempt++) {
      assert.equal(engine.exitCode, null, output);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(f.gateway.registry.enrollmentStatus("engine-b"), "connected", output);
    const cookie = `reach_console=${f.cookies().get("reach_console")}`;
    const stream = await fetch(`${f.base}/api/console/events`, { headers: { cookie }, signal: abort.signal });
    assert.equal(stream.status, 200);
    streamReader = stream.body!.getReader();
    const streamed: Array<Record<string, any>> = [];
    const reading = (async () => {
      let pending = "";
      const decoder = new TextDecoder();
      while (!abort.signal.aborted) {
        const chunk = await streamReader!.read();
        if (chunk.done) return;
        pending += decoder.decode(chunk.value, { stream: true });
        let end: number;
        while ((end = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, end); pending = pending.slice(end + 2);
          const data = frame.split("\n").find(line => line.startsWith("data: "));
          if (data) streamed.push(JSON.parse(data.slice(6)));
        }
      }
    })().catch(error => { if (!abort.signal.aborted) throw error; });
    const headers = { authorization: `Bearer ${f.controllerToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
    const initialized = await fetch(`${f.base}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "integration-client", version: "1" } } }) });
    const sessionHeaders = { ...headers, "mcp-session-id": initialized.headers.get("mcp-session-id")! };
    await fetch(`${f.base}/mcp`, { method: "POST", headers: sessionHeaders, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    await fetch(`${f.base}/mcp`, { method: "POST", headers: sessionHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "pick_device", arguments: { deviceId: "engine-b" } } }) });
    for (let attempt = 0; attempt < 400 && f.gateway.registry.apis.get("engine-b")!.status().status !== "ready"; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.gateway.registry.apis.get("engine-b")!.status().status, "ready", output);
    const read = await fetch(`${f.base}/mcp`, { method: "POST", headers: sessionHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fs_read", arguments: { deviceId: "engine-b", workspace: "default", path: "note.txt" } } }) });
    assert.ok((await read.text()).includes("local integration fixture"));
    const privateContent = "private-write-body-never-audited";
    const write = async (id: number, path: string) => {
      const response = await fetch(`${f.base}/mcp`, { method: "POST", headers: sessionHeaders, body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: {
        name: "fs_write", arguments: { deviceId: "engine-b", workspace: "default", path, mode: "create", content: privateContent },
      } }) });
      assert.equal(response.status, 200);
      return await response.json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
    };
    const denied = await write(4, "escape/denied.txt");
    assert.equal(denied.result.isError, true);
    assert.match(denied.result.content[0].text, /WORKSPACE_ACCESS_DENIED/);
    assert.equal(existsSync(join(outside, "denied.txt")), false);
    const allowed = await write(5, "created.txt");
    assert.notEqual(allowed.result.isError, true);
    assert.equal(readFileSync(join(workspace, "created.txt"), "utf8"), privateContent);
    f.gateway.audit!.flush();
    const activity = await f.call("activity?engineId=engine-b&clientLabel=integration-client%201");
    const rows = activity.data.rows as Array<Record<string, any>>;
    for (const [path, outcome] of [["note.txt", "ok"], ["escape/denied.txt", "error"], ["created.txt", "ok"]]) {
      const row = rows.find(row => row.path === path);
      assert.ok(row, `missing audit row for ${path}`);
      assert.equal(row.eventType, "rpc.finished");
      assert.equal(row.outcome, outcome);
      assert.equal(row.clientLabel, "integration-client 1");
      for (let attempt = 0; attempt < 100 && !streamed.some(event => event.type === "rpc.finished" && event.requestId === row.requestId); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(streamed.some(event => event.type === "rpc.started" && event.requestId === row.requestId && event.caller.label === row.clientLabel));
      assert.ok(streamed.some(event => event.type === "rpc.finished" && event.requestId === row.requestId && event.outcome === outcome && event.caller.label === row.clientLabel));
    }
    assert.ok(!JSON.stringify(rows).includes(privateContent));
    assert.ok(!JSON.stringify(streamed).includes(privateContent));
    const exported = await fetch(`${f.base}/api/console/activity/export?format=csv&engineId=engine-b`, { headers: { cookie } });
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get("content-disposition")!, /reach-activity-.*\.csv/);
    const csv = await exported.text();
    assert.match(csv, /integration-client 1/);
    assert.match(csv, /created.txt/);
    assert.ok(!csv.includes(privateContent));
    abort.abort();
    await reading;
    const snapshot = await f.call("snapshot");
    assert.equal(snapshot.response.status, 200);
    const device = snapshot.data.engines.find((entry: Record<string, unknown>) => entry.id === "engine-b");
    assert.equal(device.session.status, "ready");
    assert.equal(device.displayName, "Device B");
    assert.equal(device.enrollmentStatus, "connected");
    assert.deepEqual(device.session.processWorkspaces, []);
    assert.deepEqual(Object.keys(device.hardware).sort(), ["arch", "kind", "model", "os", "osVersion"]);
    assert.ok(!JSON.stringify(snapshot.data).includes(enrolled.data.token));
    assert.equal((await f.call(`clients/${encodeURIComponent("integration-client 1")}/disconnect`, {})).response.status, 200);
    assert.equal((await fetch(`${f.base}/mcp`, { method: "POST", headers: sessionHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ping" }) })).status, 404);
    assert.ok(f.gateway.events!.replay(0).some(event => event.reason === "console"));
  } finally {
    abort.abort();
    await streamReader?.cancel().catch(() => {});
    if (engine && engine.exitCode === null && engine.signalCode === null) { const exited = once(engine, "exit"); engine.kill(); await exited; }
    await f.close();
  }
});

test("console sessions expire after twelve hours idle and seven days absolute", async () => {
  const f = await fixture();
  try {
    await f.setup();
    f.advance(12 * 60 * 60_000);
    assert.equal((await f.call("engines")).response.status, 401);
    await f.call("me");
    assert.equal((await f.call("login", { username: "owner", password: "a long owner password" })).response.status, 200);
    for (let hour = 0; hour < 7 * 24; hour++) {
      f.advance(60 * 60_000);
      const result = await f.call("me");
      assert.equal(result.data.authenticated, hour < 7 * 24 - 1);
    }
  } finally { await f.close(); }
});

test("CSRF, Origin and credential isolation protect the console and data plane", async () => {
  const f = await fixture();
  try {
    await f.setup();
    assert.equal((await f.call("logout", {}, { origin: "https://foreign.example.com" })).response.status, 403);
    assert.equal((await f.call("logout", {}, { "x-csrf-token": "" })).response.status, 403);
    assert.equal((await f.call("me")).data.authenticated, true);
    const dataPlane = await fetch(`${f.base}/session/rpc`, { method: "POST", headers: { cookie: `reach_console=${f.cookies().get("reach_console")}` }, body: "{}" });
    assert.equal(dataPlane.status, 401);
    assert.equal((await f.call("engines", undefined, { cookie: "", authorization: `Bearer ${f.controllerToken}` })).response.status, 401);
    const events = f.gateway.events!.replay(0);
    assert.ok(events.some(event => event.action?.startsWith("admin.setup")));
    assert.ok(events.some(event => event.type === "auth.failed"));
  } finally { await f.close(); }
});

test("five failed setup attempts apply back-off even when credentials become correct", async () => {
  const f = await fixture();
  try {
    await f.call("me");
    const body = { username: "owner", password: "a long owner password" };
    for (let attempt = 0; attempt < 5; attempt++) assert.equal((await f.call("setup", { token: "wrong", ...body })).response.status, 403);
    const limited = await f.call("setup", { token: "test-setup-token", ...body });
    assert.equal(limited.response.status, 429);
    assert.equal(limited.response.headers.get("retry-after"), "30");
    f.advance(30_000);
    assert.equal((await f.call("setup", { token: "test-setup-token", ...body })).response.status, 200);
  } finally { await f.close(); }
});

test("proxy resolution ignores untrusted forwarding and walks trusted hops from the socket", () => {
  const request = (peer: string, forwarded: string) => ({ socket: { remoteAddress: peer }, headers: { "x-forwarded-for": forwarded } }) as unknown as IncomingMessage;
  const resolver = new PeerResolver(["192.0.2.0/24", "2001:db8::/32"]);
  assert.equal(resolver.resolve(request("198.51.100.1", "203.0.113.2")), "198.51.100.1");
  assert.equal(resolver.resolve(request("::ffff:192.0.2.1", "203.0.113.2, 192.0.2.2")), "203.0.113.2");
  assert.equal(resolver.resolve(request("192.0.2.1", "203.0.113.99, 198.51.100.2")), "198.51.100.2");
  assert.equal(resolver.resolve(request("2001:db8::1", "2001:db8:1::1, 198.51.100.2")), "198.51.100.2");
  assert.throws(() => new PeerResolver(["192.0.2.0/99"]));
  const limiter = new AuthRateLimiter(() => 0);
  for (let peer = 0; peer < 100; peer++) limiter.failed(String(peer));
  assert.throws(() => limiter.check("new peer"), /Too many/);
});

test("console SSE requires a session and replays event ids 4181 through 4200 in order", async () => {
  const f = await fixture();
  const abort = new AbortController();
  try {
    assert.equal((await fetch(`${f.base}/api/console/events`)).status, 401);
    await f.setup();
    const events = f.gateway.events!;
    while ((events.replay(0).at(-1)?.id ?? 0) < 4200) events.emit("rpc.started");
    const stream = await fetch(`${f.base}/api/console/events`, { headers: {
      cookie: `reach_console=${f.cookies().get("reach_console")}`, "last-event-id": "4180",
    }, signal: abort.signal });
    assert.equal(stream.headers.get("content-type"), "text/event-stream");
    assert.equal(stream.headers.get("cache-control"), "no-cache");
    assert.equal(stream.headers.get("x-accel-buffering"), "no");
    const reader = stream.body!.getReader();
    let text = "";
    const deadline = Date.now() + 2000;
    while (!text.includes("id: 4200\n")) {
      assert.ok(Date.now() < deadline);
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      text += new TextDecoder().decode(chunk.value);
    }
    const ids = [...text.matchAll(/^id: (\d+)$/gm)].map(match => Number(match[1]));
    assert.deepEqual(ids.slice(0, 20), Array.from({ length: 20 }, (_, index) => 4181 + index));
    abort.abort();
    await reader.cancel().catch(() => {});
  } finally { abort.abort(); await f.close(); }
});

test("console resource errors keep distinct meanings and snapshots expose stable warning codes", async () => {
  const f = await fixture();
  try {
    await f.setup();
    const cases: Array<[string, unknown, string, number, string, string]> = [
      ["engines", { id: "engine-a", displayName: "Duplicate" }, "POST", 409, "ENGINE_ID_EXISTS", "Engine id already exists"],
      ["engines/engine-a/rotate", {}, "POST", 409, "ENGINE_CONFIG_MANAGED", "Engine is managed by Gateway configuration"],
      ["access-clients", { name: "Client", expiresAt: f.now() - 1 }, "POST", 400, "INVALID_CREDENTIAL_EXPIRY", "Credential expiry must be a future timestamp"],
      ["access-clients/missing", undefined, "GET", 404, "CLIENT_IDENTITY_NOT_FOUND", "Unknown client identity"],
      ["oauth/missing", undefined, "DELETE", 404, "OAUTH_APPLICATION_NOT_FOUND", "Unknown OAuth application"],
    ];
    for (const [path, body, method, status, code, message] of cases) {
      const result = await f.call(path, body, {}, method);
      assert.equal(result.response.status, status);
      assert.deepEqual(result.data, { code, error: message });
    }
    const { data } = await f.call("snapshot");
    const warning = data.gateway.warningDetails.find((warning: { code: string }) => warning.code === "NO_TRUSTED_PROXIES");
    assert.ok(warning);
    assert.ok(data.gateway.warnings.includes(warning.message));
  } finally { await f.close(); }
});

test("read-only users can read everything but every non-self-service mutation is ROLE_FORBIDDEN", async () => {
  const f = await fixture();
  try {
    await f.setup();
    assert.equal((await f.call("engines", { id: "engine-b", displayName: "Device B" })).response.status, 201);
    const created = await f.call("users", { username: "viewer", password: "a long viewer password", role: "user" });
    assert.equal(created.response.status, 201, JSON.stringify(created.data));
    assert.deepEqual(Object.keys(created.data.user).sort(), ["createdAt", "disabled", "id", "lastLoginAt", "role", "totpEnabled", "username"]);
    const signedIn = await f.signInAs("viewer", "a long viewer password");
    assert.equal(signedIn.response.status, 200);
    assert.equal(signedIn.data.user.role, "user");
    for (const path of ["snapshot", "engines", "clients", "activity", "settings", "access-clients", "oauth"]) {
      assert.equal((await f.call(path)).response.status, 200, path);
    }
    assert.equal((await f.call("users")).data.code, "ROLE_FORBIDDEN", "user management is hidden from viewers");
    // Recent re-authentication does not lift the role check.
    assert.equal((await f.call("reauth", { password: "a long viewer password" })).response.status, 200);
    const mutations: Array<[string, unknown, string]> = [
      ["engines", { id: "engine-c", displayName: "C" }, "POST"], ["engines/engine-b", { displayName: "Renamed" }, "PATCH"],
      ["engines/engine-b/rotate", {}, "POST"], ["engines/engine-b", {}, "DELETE"],
      ["clients/x/disconnect", {}, "POST"], ["oauth/x", {}, "DELETE"],
      ["access-clients", { name: "x", expiresAt: f.now() + 3_600_000, permissions: [] }, "POST"], ["access-clients/x", {}, "DELETE"],
      ["settings", { theme: "dark" }, "PATCH"], ["settings", { retentionDays: 9 }, "PATCH"],
      ["users", { username: "other", password: "a long other password", role: "admin" }, "POST"], ["users/1", { role: "user" }, "PATCH"],
      ["users/1/password", { password: "a long new password" }, "POST"], ["users/1/totp", {}, "DELETE"], ["users/1", {}, "DELETE"],
    ];
    for (const [path, body, method] of mutations) {
      const result = await f.call(path, body, {}, method);
      assert.equal(result.response.status, 403, `${method} ${path}`);
      assert.equal(result.data.code, "ROLE_FORBIDDEN", `${method} ${path}`);
    }
    assert.ok(f.gateway.registry.engines.has("engine-b"));
    assert.equal(f.gateway.registry.engines.get("engine-b")!.displayName, "Device B");
    // Self-service stays open.
    assert.equal((await f.call("account/password", { current: "a long viewer password", password: "a newer viewer password" })).response.status, 200);
    assert.equal((await f.call("logout", {})).response.status, 200);
  } finally { await f.close(); }
});

test("admins manage users with re-authentication, the last enabled admin is protected and revocations are immediate", async () => {
  const f = await fixture();
  try {
    await f.setup();
    const ops = (await f.call("users", { username: "ops", password: "a long ops password", role: "admin" })).data.user;
    assert.equal((await f.call("users", { username: "OPS", password: "a long ops password", role: "user" })).data.code, "USERNAME_TAKEN");
    assert.equal((await f.call("users", { username: "o", password: "a long ops password", role: "user" })).data.code, "USERNAME_INVALID");
    assert.equal((await f.call("users", { username: "short", password: "too short", role: "user" })).data.code, "PASSWORD_LENGTH");
    const listed = await f.call("users");
    assert.deepEqual(listed.data.users.map((user: { username: string }) => user.username), ["owner", "ops"]);
    assert.ok(!/scrypt|password_hash|totp_secret/.test(JSON.stringify(listed.data)));
    // ops signs in, then owner demotes ops: the next ops mutation is forbidden without signing in again.
    assert.equal((await f.signInAs("ops", "a long ops password")).response.status, 200);
    const opsCookies = f.cookies();
    assert.equal((await f.call("engines", { id: "engine-b", displayName: "B" })).response.status, 201);
    f.reset();
    assert.equal((await f.signInAs("owner", "a long owner password")).response.status, 200);
    assert.equal((await f.call(`users/${ops.id}`, { role: "user" }, {}, "PATCH")).response.status, 200);
    const opsCookie = [...opsCookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const opsMe = await fetch(`${f.base}/api/console/me`, { headers: { cookie: opsCookie } });
    const opsCsrf = (await opsMe.json() as { csrfToken: string }).csrfToken;
    const demoted = await fetch(`${f.base}/api/console/engines/engine-b`, { method: "DELETE", headers: { cookie: opsCookie, origin: f.origin, "x-csrf-token": opsCsrf } });
    assert.equal(demoted.status, 403);
    assert.equal((await demoted.json() as { code: string }).code, "ROLE_FORBIDDEN");
    // Disabling revokes ops's sessions at once and blocks sign-in.
    assert.equal((await f.call(`users/${ops.id}`, { disabled: true }, {}, "PATCH")).response.status, 200);
    assert.equal((await fetch(`${f.base}/api/console/snapshot`, { headers: { cookie: opsCookie } })).status, 401);
    const events = f.gateway.events!.replay(0).filter(event => event.type === "admin.action").map(event => event.action);
    for (const action of [`user.create:ops`, `user.role.user:ops`, `user.disable:ops`]) assert.ok(events.includes(action), action);
    // Last enabled admin.
    for (const [path, body, method] of [["users/1", { role: "user" }, "PATCH"], ["users/1", { disabled: true }, "PATCH"], ["users/1", {}, "DELETE"]] as const) {
      const result = await f.call(path, body, {}, method);
      assert.equal(result.response.status, 409, `${method} ${JSON.stringify(body)}`);
      assert.equal(result.data.code, "LAST_ADMIN");
    }
    // Stale sessions must re-authenticate before managing users.
    f.advance(10 * 60_000);
    const stale = await f.call("users", { username: "late", password: "a long late password", role: "user" });
    assert.equal(stale.data.code, "REAUTH_REQUIRED");
    assert.equal((await f.call("users")).data.users.length, 2);
    assert.equal((await f.call("reauth", { password: "a long owner password" })).response.status, 200);
    assert.equal((await f.call(`users/${ops.id}/password`, { password: "a reset ops password" })).response.status, 200);
    assert.equal((await f.call(`users/${ops.id}`, { disabled: false }, {}, "PATCH")).response.status, 200);
    assert.equal((await f.signInAs("ops", "a long ops password")).data.code, "INVALID_CREDENTIALS");
    assert.equal((await f.signInAs("ops", "a reset ops password")).response.status, 200);
    f.reset();
    assert.equal((await f.signInAs("owner", "a long owner password")).response.status, 200);
    assert.equal((await f.call(`users/${ops.id}`, {}, {}, "DELETE")).response.status, 200);
    assert.equal((await f.signInAs("ops", "a reset ops password")).data.code, "INVALID_CREDENTIALS");
  } finally { await f.close(); }
});

test("self-service password and TOTP changes keep the current session and revoke the others", async () => {
  const f = await fixture();
  try {
    await f.setup();
    const first = f.cookies();
    assert.equal((await f.signInAs("owner", "a long owner password")).response.status, 200);
    const firstCookie = [...first].map(([k, v]) => `${k}=${v}`).join("; ");
    assert.equal((await fetch(`${f.base}/api/console/snapshot`, { headers: { cookie: firstCookie } })).status, 200);
    const wrong = await f.call("account/password", { current: "not my password", password: "a brand new password" });
    assert.equal(wrong.data.code, "INVALID_CREDENTIALS");
    assert.ok(f.gateway.events!.replay(0).some(event => event.type === "auth.failed"));
    assert.equal((await f.call("account/password", { current: "a long owner password", password: "a brand new password" })).response.status, 200);
    assert.equal((await f.call("me")).data.authenticated, true, "the current session survives");
    assert.equal((await fetch(`${f.base}/api/console/snapshot`, { headers: { cookie: firstCookie } })).status, 401, "other sessions are revoked");
    const { secret, recoveryCodes } = await f.enableTotp();
    assert.equal(recoveryCodes.length, 10);
    assert.equal((await f.call("account/totp/begin", {})).data.code, "TOTP_ALREADY_ENABLED");
    f.advance(30_000);
    assert.equal((await f.call("account/totp", { code: "000000" }, {}, "DELETE")).data.code, "INVALID_CREDENTIALS");
    assert.equal((await f.call("account/totp", { code: totp(secret, f.now()) }, {}, "DELETE")).response.status, 200);
    const store = new ConsoleStore(f.directory);
    try { assert.equal(store.db.prepare("SELECT count(*) AS n FROM recovery_codes").get()!.n, 0); } finally { store.close(); }
    assert.equal((await f.signInAs("owner", "a brand new password")).response.status, 200, "no code needed once TOTP is off");
  } finally { await f.close(); }
});

test("a demotion or revocation while a request body is still arriving stops its write", async () => {
  const { request: httpRequest } = await import("node:http");
  const f = await fixture();
  try {
    await f.setup();
    assert.equal((await f.call("users", { username: "ops", password: "a long ops password", role: "admin" })).response.status, 201);
    assert.equal((await f.signInAs("ops", "a long ops password")).response.status, 200);
    const opsCookie = [...f.cookies()].map(([key, value]) => `${key}=${value}`).join("; ");
    const opsCsrf = (await f.call("me")).data.csrfToken as string;
    // Start a create-device request as ops, but hold back the end of its body.
    const slow = (path: string, body: string) => {
      const url = new URL(`/api/console/${path}`, f.base);
      const pending = httpRequest(url, { method: "POST", headers: { origin: f.origin, "content-type": "application/json", "x-csrf-token": opsCsrf, cookie: opsCookie, "content-length": Buffer.byteLength(body) } });
      const done = new Promise<{ status: number; body: Record<string, any> }>((resolve, reject) => {
        pending.on("response", response => { let text = ""; response.on("data", chunk => { text += chunk; }); response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(text) })); });
        pending.on("error", reject);
      });
      pending.write(body.slice(0, 5));
      return { finish: () => { pending.end(body.slice(5)); return done; } };
    };
    const device = slow("engines", JSON.stringify({ id: "engine-late", displayName: "Late" }));
    await new Promise(resolve => setTimeout(resolve, 50));
    // Meanwhile the owner demotes ops.
    f.reset();
    assert.equal((await f.signInAs("owner", "a long owner password")).response.status, 200);
    const opsId = (await f.call("users")).data.users.find((user: { username: string }) => user.username === "ops").id;
    assert.equal((await f.call(`users/${opsId}`, { role: "user" }, {}, "PATCH")).response.status, 200);
    const result = await device.finish();
    assert.equal(result.status, 403);
    assert.equal(result.body.code, "ROLE_FORBIDDEN");
    assert.equal(f.gateway.registry.engines.has("engine-late"), false, "no device was created by the demoted request");
  } finally { await f.close(); }
});
