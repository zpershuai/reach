import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseHardware, tokenDigest } from "./registry.js";
import { EngineRegistry, type EngineRuntime } from "./registry.js";
import { ConsoleStore } from "./store.js";
import { createServer as createHttpServer } from "node:http";
import { createGateway } from "../gateway.js";
import { WebSocket } from "ws";
import { RegistryError } from "./registry.js";

function inertRuntime(): EngineRuntime {
  const result = { statusCode: 200, payload: {} };
  return { server: createHttpServer(), retire: () => {}, api: {
    status: () => ({ status: "none", engineVersion: null }), open: () => result, close: () => result,
    renew: () => result, grant: () => result, rpc: async () => result,
  } };
}

test("registry validates enrollment, keeps seeds authoritative and persists rename and override", () => {
  const registry = new EngineRegistry(inertRuntime, undefined, true);
  const local = new EngineRegistry(inertRuntime);
  assert.throws(() => local.add("engine-b", "Device"), { code: "ENGINE_AUTH_REQUIRED", message: "Multiple Engines require Gateway authentication" });
  registry.seed("seed", "s".repeat(48));
  for (const operation of [() => registry.remove("seed"), () => registry.rotate("seed")]) {
    assert.throws(operation, (error: unknown) => error instanceof RegistryError && error.status === 409 && error.code === "ENGINE_CONFIG_MANAGED");
  }
  for (const id of ["", "a".repeat(65), "../engine", "space id", "设备"]) assert.throws(() => registry.add(id, "Device"), /Invalid Engine id/);
  registry.add("engine._-1", "Device");
  assert.throws(() => registry.add("engine._-1", "Other"), { code: "ENGINE_ID_EXISTS", message: "Engine id already exists" });
  registry.update("seed", { displayName: "New name", deviceOverride: { kind: "nas", model: "4-bay NAS" } });
  assert.equal(registry.engines.get("seed")!.displayName, "New name");
  assert.equal(registry.engines.get("seed")!.deviceOverride!.kind, "nas");
  registry.update("seed", { deviceOverride: null });
  assert.equal(registry.engines.get("seed")!.deviceOverride, null);
});

test("runtime enrollment, rotation and removal update heartbeat, REST and MCP without restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reach-registry-live-"));
  const controllerToken = "c".repeat(48);
  const gateway = createGateway({
    authentication: { controllerToken, engineId: "engine-a", engineToken: "a".repeat(48) },
    console: { dataDir: directory, publicOrigin: "http://127.0.0.1:8787", trustedProxies: [], retentionDays: 30 }, logger: () => {},
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  let socket: WebSocket | undefined;
  try {
    const address = gateway.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const post = (path: string, body: unknown, token = controllerToken) => fetch(`${base}${path}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    let sequence = 0;
    let mcpId: string | null = null;
    const mcp = async (method: string, params: unknown = {}, notification = false): Promise<Response> => {
      const response = await fetch(`${base}/mcp`, { method: "POST", headers: {
        authorization: `Bearer ${controllerToken}`, "content-type": "application/json", accept: "application/json, text/event-stream",
        ...(mcpId ? { "mcp-session-id": mcpId } : {}),
      }, body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: ++sequence }), method, params }) });
      mcpId ??= response.headers.get("mcp-session-id");
      return response;
    };
    assert.equal((await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "1" } })).status, 200);
    await mcp("notifications/initialized", {}, true);
    const enrolled = gateway.registry.add("engine-b", "Device B");
    assert.equal(gateway.registry.enrollmentStatus("engine-b"), "awaiting_heartbeat");
    assert.equal((await post("/heartbeat", { device: { id: "engine-b" } }, "wrong")).status, 401);
    assert.equal(gateway.registry.enrollmentStatus("engine-b"), "awaiting_heartbeat");
    assert.equal((await post("/heartbeat", { device: { id: "engine-b" } }, enrolled.token)).status, 200);
    assert.equal(gateway.registry.enrollmentStatus("engine-b"), "connected");
    assert.equal(gateway.registry.engines.get("engine-b")!.hardware, null);
    const hardware = { kind: "mac-mini", model: "Mac mini (M4, 2024)", os: "macOS", osVersion: "15.6", arch: "arm64" };
    assert.equal((await post("/heartbeat", { device: { id: "engine-b", hardware } }, enrolled.token)).status, 200);
    assert.deepEqual(gateway.registry.engines.get("engine-b")!.hardware, hardware);
    assert.equal((await post("/heartbeat", { device: { id: "engine-b", hardware: { ...hardware, model: "x".repeat(500) } } }, enrolled.token)).status, 200);
    assert.deepEqual(gateway.registry.engines.get("engine-b")!.hardware, hardware);
    assert.equal((await post("/heartbeat", { device: { id: "engine-b" } }, enrolled.token)).status, 200);
    assert.deepEqual(gateway.registry.engines.get("engine-b")!.hardware, hardware);
    assert.deepEqual(gateway.events!.replay(0).filter(event => event.type === "engine.heartbeat").at(-1)!.hardware, hardware);
    assert.equal(parseHardware({ ...hardware, kind: "unrecognized" })!.kind, "unknown");
    assert.equal(parseHardware({ ...hardware, os: "bad\nvalue" }), undefined);
    const listed = await (await mcp("tools/call", { name: "list_devices" })).text();
    assert.ok(listed.includes("engine-b"));
    await post("/session/open?engineId=engine-b", { sessionId: "session-b" });
    const lease = await (await post("/heartbeat", { device: { id: "engine-b" } }, enrolled.token)).json() as { endpoint: string; token: string };
    socket = new WebSocket(`${base.replace("http:", "ws:")}${lease.endpoint}&token=${lease.token}`);
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "session.ready", protocol: "reach-rpc", version: "1.0", sessionId: "session-b", engineId: "engine-b", workspaces: ["default"], methods: ["fs.write"] }));
    for (let attempt = 0; attempt < 100 && gateway.registry.apis.get("engine-b")!.status().status !== "ready"; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(gateway.registry.apis.get("engine-b")!.status().status, "ready");
    const rotated = gateway.registry.rotate("engine-b");
    assert.equal((await post("/heartbeat", { device: { id: "engine-b" } }, enrolled.token)).status, 401);
    assert.equal((await post("/heartbeat", { device: { id: "engine-b" } }, rotated)).status, 200);
    assert.equal(gateway.registry.apis.get("engine-b")!.status().status, "ready");
    assert.equal(socket.readyState, WebSocket.OPEN);
    const audit = new ConsoleStore(directory);
    audit.db.prepare("INSERT INTO activity(ts,event_type,engine_id) VALUES (?,?,?)").run(Date.now(), "rpc.finished", "engine-b");
    const closed = once(socket, "close");
    const closeFrame = once(socket, "message");
    gateway.registry.remove("engine-b");
    const [frame] = await closeFrame;
    assert.equal(JSON.parse(String(frame)).reason, "agent_requested");
    await closed;
    assert.equal((await post("/session/status?engineId=engine-b", {})).status, 404);
    assert.equal((await post("/heartbeat", { device: { id: "engine-b" } }, rotated)).status, 401);
    assert.ok((await (await mcp("tools/call", { name: "device_status", arguments: { deviceId: "engine-b" } })).text()).includes("Unknown device"));
    assert.ok(!(await (await mcp("tools/call", { name: "list_devices" })).text()).includes("engine-b"));
    assert.equal(audit.db.prepare("SELECT count(*) AS count FROM activity WHERE engine_id='engine-b'").get()!.count, 1);
    audit.close();
  } finally {
    socket?.terminate();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restart keeps a console Engine and upserts changed seed digests without losing metadata", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reach-registry-restart-"));
  const controllerToken = "c".repeat(48);
  let store = new ConsoleStore(directory);
  try {
    const first = new EngineRegistry(inertRuntime, store, true);
    first.seed("engine-a", "a".repeat(48));
    store.db.prepare("UPDATE engines SET display_name=?, device_override=?, hardware=? WHERE id=?").run(
      "My device", JSON.stringify({ kind: "nas", model: "4-bay NAS" }),
      JSON.stringify({ kind: "server", model: "Generic", os: "Linux", osVersion: "1", arch: "arm64" }), "engine-a",
    );
    const enrolled = first.add("engine-b", "Enrolled device");
    assert.equal(Buffer.from(enrolled.token, "hex").length, 32);
    assert.ok(!JSON.stringify(store.db.prepare("SELECT * FROM engines").all()).includes(enrolled.token));
    store.close();
    store = new ConsoleStore(directory);
    const second = new EngineRegistry(inertRuntime, store, true);
    second.seed("engine-a", "z".repeat(48));
    assert.equal(second.verifyToken("engine-a", "a".repeat(48)), false);
    assert.equal(second.verifyToken("engine-a", "z".repeat(48)), true);
    assert.equal(second.verifyToken("engine-b", enrolled.token), true);
    assert.equal(second.engines.get("engine-a")!.displayName, "My device");
    assert.equal(second.engines.get("engine-a")!.deviceOverride!.kind, "nas");
    assert.equal(second.engines.get("engine-a")!.hardware!.os, "Linux");
    second.seed("engine-old", "o".repeat(48));
    store.close();
    store = new ConsoleStore(directory);
    const third = new EngineRegistry(inertRuntime, store, true);
    third.seed("engine-a", "z".repeat(48));
    third.retainSeeds(new Set(["engine-a"]));
    assert.equal(third.engines.has("engine-old"), false);
    assert.equal(third.authenticate("o".repeat(48)), undefined);
    assert.equal(third.verifyToken("engine-b", enrolled.token), true);
    store.close();
    store = new ConsoleStore(directory);
    const gateway = createGateway({
      authentication: { controllerToken, engineId: "engine-a", engineToken: "z".repeat(48) },
      console: { dataDir: directory, publicOrigin: "http://127.0.0.1:8787", trustedProxies: [], retentionDays: 30 },
      logger: () => {},
    });
    gateway.listen(0, "127.0.0.1");
    await once(gateway, "listening");
    try {
      const address = gateway.address();
      assert.ok(address && typeof address === "object");
      const response = await fetch(`http://127.0.0.1:${address.port}/heartbeat`, {
        method: "POST", headers: { authorization: `Bearer ${enrolled.token}` }, body: JSON.stringify({ device: { id: "engine-b" } }),
      });
      assert.equal(response.status, 200);
    } finally { await new Promise<void>(resolve => gateway.close(() => resolve())); }
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("environment and file seeds authenticate with and without console storage", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reach-registry-"));
  const controllerToken = "c".repeat(48);
  const seeds = [{ engineId: "engine-a", engineToken: "a".repeat(48) }, { engineId: "engine-b", engineToken: "b".repeat(48) }];
  const file = join(directory, "engines.json");
  writeFileSync(file, JSON.stringify([seeds[1]]));
  try {
    for (const persistent of [false, true]) {
      const reservation = createServer();
      reservation.listen(0, "127.0.0.1");
      await once(reservation, "listening");
      const address = reservation.address();
      assert.ok(address && typeof address === "object");
      await new Promise<void>(resolve => reservation.close(() => resolve()));
      const env: NodeJS.ProcessEnv = {
        ...process.env, GATEWAY_HOST: "127.0.0.1", GATEWAY_PORT: String(address.port),
        REACH_CONTROLLER_TOKEN: controllerToken, REACH_ENGINE_ID: seeds[0].engineId,
        REACH_ENGINE_TOKEN: seeds[0].engineToken, REACH_ENGINES_FILE: file,
      };
      delete env.REACH_DATA_DIR;
      if (persistent) env.REACH_DATA_DIR = join(directory, "data");
      const child = spawn(process.execPath, [new URL("../gateway-main.js", import.meta.url).pathname], { env, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", chunk => { output += chunk; });
      child.stderr.on("data", chunk => { output += chunk; });
      try {
        const deadline = Date.now() + 5000;
        while (!output.includes("listening on")) {
          assert.equal(child.exitCode, null, output);
          assert.ok(Date.now() < deadline, output);
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        const base = `http://127.0.0.1:${address.port}`;
        for (const seed of seeds) {
          const response = await fetch(`${base}/heartbeat`, { method: "POST", headers: { authorization: `Bearer ${seed.engineToken}` }, body: JSON.stringify({ device: { id: seed.engineId } }) });
          assert.equal(response.status, 200);
          const bad = await fetch(`${base}/heartbeat`, { method: "POST", headers: { authorization: `Bearer wrong-${seed.engineToken}` }, body: JSON.stringify({ device: { id: seed.engineId } }) });
          assert.equal(bad.status, 401);
        }
        const open = await fetch(`${base}/session/open`, { method: "POST", headers: { authorization: `Bearer ${controllerToken}` }, body: "{}" });
        assert.equal(open.status, 200);
      } finally {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
    }
    assert.equal(tokenDigest("a").length, 64);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
