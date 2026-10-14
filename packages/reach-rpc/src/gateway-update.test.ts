import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { GATEWAY_VERSION } from "./version.js";
import { createGateway } from "./gateway.js";
import { GatewayUpdater, parseUpdateConfig, selectRelease, updateAdmissionPaused, type Release, type UpdateConfig } from "./gateway-update.js";

const digest = "a".repeat(64);
const versionParts = GATEWAY_VERSION.split(".").map(BigInt);
const nextVersion = `${versionParts[0]}.${versionParts[1]}.${versionParts[2] + 1n}`;
function release(version: string, extra: Partial<Release> = {}): Release {
  return { tag_name: `gateway-v${version}`, draft: false, prerelease: false, assets: [
    { name: "gateway-amd64.tgz", url: "https://api.github.com/repos/example/reach/releases/assets/1" },
    { name: "SHA256SUMS", url: "https://api.github.com/repos/example/reach/releases/assets/2" },
  ], ...extra };
}
function config(directory: string): UpdateConfig {
  return { repo: "example/reach", intervalMs: 3_600_000, backend: "compose", requestDir: directory };
}
function fixtureFetch(releases = [release(nextVersion)]): typeof fetch {
  return async (input, init) => {
    assert.equal((init?.headers as Record<string, string>)["User-Agent"], `reach-gateway/${GATEWAY_VERSION}`);
    return String(input).includes("/assets/") ? new Response(`${digest}  gateway-amd64.tgz\n`)
      : Response.json(releases);
  };
}

function intent(directory: string, expiresAt: number): void {
  writeFileSync(join(directory, "apply.json"), JSON.stringify({ component: "gateway", version: nextVersion, asset: "gateway-amd64.tgz", digest, repo: "example/reach", nonce: "b".repeat(32), expiresAt }));
}

test("update config is omitted-safe and validates enabled configuration before startup", () => {
  assert.equal(parseUpdateConfig({}), undefined);
  assert.equal(parseUpdateConfig({ REACH_UPDATE_ENABLED: "yes", REACH_UPDATE_INTERVAL_SECS: "invalid" }), undefined);
  const env = { REACH_UPDATE_ENABLED: "true", REACH_UPDATE_REPO: "example/reach", REACH_UPDATE_REQUEST_DIR: "/tmp/reach-update" };
  assert.equal(parseUpdateConfig(env)?.intervalMs, 3_600_000);
  for (const override of [
    { REACH_UPDATE_REPO: "invalid" }, { REACH_UPDATE_INTERVAL_SECS: "0" },
    { REACH_UPDATE_INTERVAL_SECS: "59" }, { REACH_UPDATE_INTERVAL_SECS: "1e3" },
    { REACH_UPDATE_BACKEND: "invalid" }, { REACH_UPDATE_REQUEST_DIR: "" },
  ]) assert.throws(() => parseUpdateConfig({ ...env, ...override }));
});

test("component releases select the highest stable SemVer and ignore equal, older, draft and prerelease", () => {
  assert.equal(selectRelease([release("0.3.1"), release("0.3.0")], "0.3.1"), undefined);
  assert.equal(selectRelease([release("0.4.0"), release("0.10.0"), release("9.0.0", { draft: true }), release("8.0.0", { prerelease: true }), release("3.0.0-rc.1")], "0.3.1")?.tag_name, "gateway-v0.10.0");
});

test("idle updater writes an atomic verified request; wanted/live sessions retain pending until idle", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reach-update-"));
  try {
    let status = "wanted";
    let fetches = 0;
    const updater = new GatewayUpdater(config(directory), () => status === "none", () => {}, async (...args) => { fetches++; return fixtureFetch()(...args); });
    await updater.tick();
    assert.equal(existsSync(join(directory, "request.json")), false);
    status = "ready";
    await updater.tick();
    assert.equal(existsSync(join(directory, "request.json")), false);
    status = "none";
    await updater.tick();
    assert.deepEqual(JSON.parse(readFileSync(join(directory, "request.json"), "utf8")), { component: "gateway", version: nextVersion, asset: "gateway-amd64.tgz", digest, repo: "example/reach" });
    assert.equal(fetches, 2);
  } finally { rmSync(directory, { recursive: true }); }
});

test("failed GitHub checks back off independently and do not write requests", async () => {
  let now = 0;
  let requests = 0;
  const directory = mkdtempSync(join(tmpdir(), "reach-update-"));
  try {
    const updater = new GatewayUpdater(config(directory), () => true, () => {}, async () => { requests++; return new Response("error", { status: 503 }); }, () => now);
    assert.equal(await updater.tick(), 1000);
    now = 1000;
    assert.equal(await updater.tick(), 2000);
    assert.equal(requests, 2);
    assert.equal(existsSync(join(directory, "request.json")), false);
  } finally { rmSync(directory, { recursive: true }); }
});

test("prepared helper intent waits for idle and admission releases on expiry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reach-update-"));
  let now = 0;
  let idle = false;
  try {
    const updater = new GatewayUpdater(config(directory), () => idle, () => {}, fixtureFetch([release(GATEWAY_VERSION)]), () => now);
    assert.equal(updateAdmissionPaused(config(directory), now), false);
    intent(directory, 10_000);
    assert.equal(updateAdmissionPaused(config(directory), now), true);
    await updater.tick();
    assert.equal(existsSync(join(directory, "idle.json")), false);
    idle = true;
    await updater.tick();
    assert.deepEqual(JSON.parse(readFileSync(join(directory, "idle.json"), "utf8")), { component: "gateway", version: nextVersion, nonce: "b".repeat(32) });
    now = 10_000;
    assert.equal(updateAdmissionPaused(config(directory), now), false);
  } finally { rmSync(directory, { recursive: true }); }
});

async function withGateway(options: Parameters<typeof createGateway>[0], run: (url: string) => Promise<void>): Promise<void> {
  const gateway = createGateway({ logger: () => {}, ...options });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const address = gateway.address();
  assert.ok(address && typeof address === "object");
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise<void>((resolve, reject) => gateway.close(error => error ? reject(error) : resolve())); }
}

test("disabled Gateway never fetches and enabled GitHub errors keep the HTTP listener up", async () => {
  let calls = 0;
  const failingFetch: typeof fetch = async () => { calls++; return new Response("error", { status: 503 }); };
  await withGateway({ updateFetch: failingFetch }, async url => {
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await fetch(`${url}/healthz`)).status, 200);
    assert.equal(calls, 0);
  });
  const directory = mkdtempSync(join(tmpdir(), "reach-update-"));
  try {
    await withGateway({ update: config(directory), updateFetch: failingFetch }, async url => {
      for (let i = 0; calls === 0 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(calls, 1);
      assert.equal((await fetch(`${url}/healthz`)).status, 200);
    });
  } finally { rmSync(directory, { recursive: true }); }
});

test("any registered Engine wanted session defers the Gateway request after an awaited fetch", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reach-update-"));
  let releaseFetch!: () => void;
  const gate = new Promise<void>(resolve => { releaseFetch = resolve; });
  let calls = 0;
  const mocked: typeof fetch = async (...args) => { calls++; await gate; return fixtureFetch()(...args); };
  const controllerToken = "c".repeat(48);
  try {
    await withGateway({ update: config(directory), updateFetch: mocked,
      authentication: { controllerToken, engineToken: "e".repeat(48), engineId: "engine-a" },
      engines: [{ engineToken: "f".repeat(48), engineId: "engine-b" }],
    }, async url => {
      const opened = await fetch(`${url}/session/open?engineId=engine-b`, { method: "POST", headers: { Authorization: `Bearer ${controllerToken}`, "Content-Type": "application/json" }, body: "{}" });
      assert.equal(opened.status, 200);
      releaseFetch();
      for (let i = 0; calls < 2 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(calls, 2);
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(existsSync(join(directory, "request.json")), false);
      const closed = await fetch(`${url}/session/close?engineId=engine-b`, { method: "POST", headers: { Authorization: `Bearer ${controllerToken}`, "Content-Type": "application/json" }, body: "{}" });
      assert.equal(closed.status, 200);
      for (let i = 0; !existsSync(join(directory, "request.json")) && i < 250; i++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(existsSync(join(directory, "request.json")), true);
    });
  } finally { releaseFetch(); rmSync(directory, { recursive: true }); }
});

test("prepared apply gates new REST and MCP sessions while status and existing close remain available", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reach-update-"));
  let now = 0;
  const controllerToken = "c".repeat(48);
  try {
    await withGateway({ update: config(directory), updateFetch: fixtureFetch([release(GATEWAY_VERSION)]), now: () => now,
      authentication: { controllerToken, engineToken: "e".repeat(48), engineId: "engine-a" },
    }, async url => {
      const headers = { Authorization: `Bearer ${controllerToken}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
      const post = (path: string, body: unknown, extra: Record<string, string> = {}) => fetch(`${url}${path}`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
      assert.equal((await post("/session/open", {})).status, 200);
      intent(directory, 10_000);
      assert.equal((await post("/session/close", {})).status, 200);
      assert.equal((await post("/session/open", {})).status, 503);
      assert.equal((await post("/session-wanted", { wanted: true })).status, 503);
      const initialized = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } });
      assert.equal(initialized.status, 200);
      const session = { "mcp-session-id": initialized.headers.get("mcp-session-id")!, "mcp-protocol-version": "2025-06-18" };
      assert.equal((await post("/mcp", { jsonrpc: "2.0", method: "notifications/initialized" }, session)).status, 202);
      const picked = await post("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "pick_device", arguments: { deviceId: "engine-a" } } }, session);
      const result = await picked.json();
      assert.equal(result.result.isError, true);
      assert.match(result.result.content[0].text, /update in progress/);
      assert.equal((await (await fetch(`${url}/session/status`, { headers })).json()).status, "none");
      now = 10_000;
      assert.equal((await post("/session/open", {})).status, 200);
      assert.equal((await post("/session/close", {})).status, 200);
    });
  } finally { rmSync(directory, { recursive: true }); }
});
