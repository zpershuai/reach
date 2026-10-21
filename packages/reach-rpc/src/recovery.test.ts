import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createGateway } from "./gateway.js";

// Real-Engine failure recovery: no automatic replay, launch identity and process-group cleanup.
const controllerToken = "c".repeat(48);
const engineToken = "e".repeat(48);
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const binary = join(repository, "target/debug/engine");

// The script counts its launches and starts an ordinary child that records its pid and keeps running.
const job = `
const { appendFileSync, writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
appendFileSync("launches.txt", process.argv[2] + "\\n");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync("child-" + process.argv[2] + ".pid", String(child.pid));
setInterval(() => {}, 1000);
`;

interface Harness { url: string; workspace: string; engine: ChildProcess; engineLog: () => string }

async function startGateway(port = 0): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const server = createGateway({ logger: () => {}, authentication: { controllerToken, engineToken, engineId: "engine-a" }, heartbeatIntervalSeconds: 1 });
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return {
    server, port: (server.address() as AddressInfo).port,
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

function startEngine(url: string, workspace: string, token = engineToken): { engine: ChildProcess; engineLog: () => string } {
  let log = "";
  const engine = spawn(binary, [url], {
    env: { PATH: process.env.PATH, HOME: workspace, REACH_ENGINE_ID: "engine-a", REACH_ENGINE_TOKEN: token,
      REACH_WORKSPACE_ROOTS: `scripts:${workspace}`, REACH_PROCESS_WORKSPACES: "scripts", REACH_PROCESS_NODE_BIN: process.execPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  engine.stdout!.on("data", (chunk) => { log += chunk; });
  engine.stderr!.on("data", (chunk) => { log += chunk; });
  return { engine, engineLog: () => log };
}

async function stopEngine(engine: ChildProcess): Promise<void> {
  if (engine.exitCode !== null || engine.signalCode !== null) return;
  const exited = once(engine, "exit"); engine.kill("SIGTERM");
  await Promise.race([exited, delay(5000)]);
  if (engine.exitCode === null && engine.signalCode === null) { engine.kill("SIGKILL"); await exited; }
}

function post(url: string, path: string, body: unknown) {
  return fetch(`${url}${path}`, { method: "POST", headers: { authorization: `Bearer ${controllerToken}`, "content-type": "application/json" }, body: JSON.stringify(body) });
}
async function status(url: string) {
  return (await fetch(`${url}/session/status`, { headers: { authorization: `Bearer ${controllerToken}` } })).json() as Promise<{ status: string; sessionId?: string; closureReason?: string; lastSeenAt?: string | null }>;
}
async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) { if (Date.now() > deadline) throw new Error("condition not reached"); await delay(50); }
}
async function openReady(url: string): Promise<string> {
  assert.equal((await post(url, "/session/open", {})).status, 200);
  await waitFor(async () => (await status(url)).status === "ready");
  return (await status(url)).sessionId!;
}
let sequence = 0;
async function rpc(url: string, method: string, params: Record<string, unknown>, grantId?: string) {
  const response = await post(url, "/session/rpc", { requestId: `r${++sequence}`, method, params, ...(grantId ? { permission: { grantId } } : {}) });
  return response.json() as Promise<{ type: string; result?: any; error?: { code: string } }>;
}
async function launch(url: string, sessionId: string, launchId: string, extra: Record<string, unknown> = {}) {
  const run = { workspace: "scripts", script: "job.cjs", launchId, args: [launchId], ...extra };
  const grant = await (await post(url, "/grants", { kind: "execute", sessionId, workspace: run.workspace, script: run.script, launchId })).json() as { grantId: string };
  return rpc(url, "process.run", run, grant.grantId);
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const childPid = (workspace: string, launchId: string) => Number(readFileSync(join(workspace, `child-${launchId}.pid`), "utf8"));
const launches = (workspace: string) => existsSync(join(workspace, "launches.txt")) ? readFileSync(join(workspace, "launches.txt"), "utf8").trim().split("\n") : [];

async function withHarness(check: (h: Harness, gateway: Awaited<ReturnType<typeof startGateway>>) => Promise<void>): Promise<void> {
  if (!existsSync(binary)) execFileSync("cargo", ["build", "--quiet", "--locked", "-p", "reach-rpc", "--bin", "engine"], { cwd: repository });
  const workspace = mkdtempSync(join(tmpdir(), "reach-recovery-"));
  writeFileSync(join(workspace, "job.cjs"), job);
  const gateway = await startGateway();
  const url = `http://127.0.0.1:${gateway.port}`;
  const { engine, engineLog } = startEngine(url, workspace);
  const harness = { url, workspace, engine, engineLog };
  try { await check(harness, gateway); }
  finally {
    await stopEngine(harness.engine);
    await gateway.close().catch(() => {});
    for (const file of ["a", "b", "c", "d"].map((id) => join(workspace, `child-${id}.pid`))) {
      if (existsSync(file)) { const pid = Number(readFileSync(file, "utf8")); if (alive(pid)) process.kill(pid, "SIGKILL"); }
    }
    rmSync(workspace, { recursive: true, force: true });
  }
}

test("an Engine with a revoked token stays offline and never receives a session", { timeout: 60_000 }, async () => {
  if (!existsSync(binary)) execFileSync("cargo", ["build", "--quiet", "--locked", "-p", "reach-rpc", "--bin", "engine"], { cwd: repository });
  const workspace = mkdtempSync(join(tmpdir(), "reach-recovery-"));
  const gateway = await startGateway();
  const url = `http://127.0.0.1:${gateway.port}`;
  const { engine, engineLog } = startEngine(url, workspace, "x".repeat(48));
  try {
    assert.equal((await post(url, "/session/open", {})).status, 200);
    await waitFor(() => engineLog().includes("HEARTBEAT_FAILED"), 10_000);
    const current = await status(url);
    assert.notEqual(current.status, "ready");
    assert.equal(current.lastSeenAt ?? null, null);
    assert.ok(!engineLog().includes("x".repeat(48)), "Engine diagnostics must not echo its token");
  } finally { await stopEngine(engine); await gateway.close(); rmSync(workspace, { recursive: true, force: true }); }
});

test("a lost launch reply is recovered by launchId without a second launch, and stop cleans descendants", { timeout: 60_000 }, async () => {
  await withHarness(async ({ url, workspace }) => {
    const sessionId = await openReady(url);
    const first = await launch(url, sessionId, "a");
    assert.equal(first.type, "response", JSON.stringify(first));
    // The client treats the first reply as lost: it queries by launchId and resends the identical launch.
    const queried = await rpc(url, "process.status", { launchId: "a" });
    assert.equal(queried.result.processId, first.result.processId);
    const resent = await launch(url, sessionId, "a");
    assert.equal(resent.result.processId, first.result.processId);
    const conflict = await launch(url, sessionId, "a", { args: ["different"] });
    assert.equal(conflict.error?.code, "LAUNCH_ID_CONFLICT");
    await waitFor(() => existsSync(join(workspace, "child-a.pid")));
    assert.deepEqual(launches(workspace), ["a"]);
    const child = childPid(workspace, "a");
    assert.ok(alive(child));
    const control = await (await post(url, "/grants", { kind: "control", sessionId, processId: first.result.processId })).json() as { grantId: string };
    assert.equal((await rpc(url, "process.stop", { processId: first.result.processId }, control.grantId)).type, "response");
    await waitFor(async () => (await rpc(url, "process.status", { processId: first.result.processId })).result.state === "stopped");
    await waitFor(() => !alive(child), 5_000);
  });
});

test("a timed-out task and a closed session terminate ordinary descendants", { timeout: 60_000 }, async () => {
  await withHarness(async ({ url, workspace }) => {
    let sessionId = await openReady(url);
    const timed = await launch(url, sessionId, "b", { timeoutMs: 1500 });
    await waitFor(() => existsSync(join(workspace, "child-b.pid")));
    await waitFor(async () => (await rpc(url, "process.status", { processId: timed.result.processId })).result.state === "timed_out");
    await waitFor(() => !alive(childPid(workspace, "b")), 5_000);

    const running = await launch(url, sessionId, "c");
    assert.equal(running.type, "response");
    await waitFor(() => existsSync(join(workspace, "child-c.pid")));
    assert.equal((await post(url, "/session/close", {})).status, 200);
    await waitFor(async () => (await status(url)).status === "none");
    await waitFor(() => !alive(childPid(workspace, "c")), 5_000);
    // A new session does not adopt or replay the previous session's task.
    sessionId = await openReady(url);
    assert.equal((await rpc(url, "process.status", { launchId: "c" })).error?.code, "PROCESS_NOT_FOUND");
    assert.deepEqual(launches(workspace), ["b", "c"]);
  });
});

test("a Gateway restart drops the session, the Engine reconnects, and no mutation is replayed", { timeout: 90_000 }, async () => {
  await withHarness(async ({ url, workspace }, gateway) => {
    const sessionId = await openReady(url);
    const grant = await (await post(url, "/grants", { workspace: "scripts", path: "note.txt", methods: ["fs.write"] })).json() as { grantId: string };
    const written = await rpc(url, "fs.write", { workspace: "scripts", path: "note.txt", content: "once", mode: "create" }, grant.grantId);
    assert.equal(written.type, "response");
    const running = await launch(url, sessionId, "d");
    assert.equal(running.type, "response");
    await waitFor(() => existsSync(join(workspace, "child-d.pid")));

    await gateway.close();
    // Losing the Gateway is a disconnect: the Engine ends the session and its process group.
    await waitFor(() => !alive(childPid(workspace, "d")), 10_000);
    const restarted = await startGateway(gateway.port);
    try {
      await waitFor(async () => Boolean((await status(url)).lastSeenAt), 15_000);
      assert.equal((await status(url)).status, "none", "A restarted Gateway does not resume or replay the old session");
      await openReady(url);
      assert.equal((await rpc(url, "process.status", { launchId: "d" })).error?.code, "PROCESS_NOT_FOUND");
      // The old grant died with the Gateway; the write is not replayed and cannot be repeated with it.
      const stale = await rpc(url, "fs.write", { workspace: "scripts", path: "note.txt", content: "twice", mode: "overwrite" }, grant.grantId);
      assert.equal(stale.error?.code, "PERMISSION_DENIED");
      assert.equal(readFileSync(join(workspace, "note.txt"), "utf8"), "once");
      assert.deepEqual(launches(workspace), ["d"]);
    } finally { await restarted.close(); }
  });
});
