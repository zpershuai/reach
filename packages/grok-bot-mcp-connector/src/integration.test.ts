import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createGateway } from "../../reach-rpc/dist/gateway.js";
import { loadConfig } from "./config.js";
import { McpServer } from "./server.js";
import { MCP_VERSION } from "./version.js";
import { GATEWAY_VERSION } from "../../reach-rpc/dist/version.js";

test("managed tasks drain on disconnect, lease, rotation and shutdown while live work prevents idle closure", async () => {
  const repository = fileURLToPath(new URL("../../..", import.meta.url));
  const build = spawn("cargo", ["build", "--quiet", "--locked", "--offline", "-p", "reach-rpc", "--bin", "engine"], { cwd: repository, stdio: "ignore" });
  assert.equal((await once(build, "exit"))[0], 0);
  for (const mode of ["disconnect", "lease", "rotation", "shutdown", "idle"] as const) {
    const root = await fs.mkdtemp(join(tmpdir(), "reach-process-lifecycle-"));
    const gateway = createGateway({ logger: () => {} });
    const sockets = new Set<Socket>();
    gateway.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    gateway.listen(0, "127.0.0.1"); await once(gateway, "listening");
    const address = gateway.address(); assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    const post = async (path: string, body: unknown) => (await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<any>;
    const status = async (): Promise<any> => {
      try { return await (await fetch(`${url}/session/status`)).json(); }
      catch (error) { if (mode === "disconnect" && error instanceof TypeError) return { status: "transport-recovering" }; throw error; }
    };
    const waitFor = async (check: () => Promise<boolean>) => {
      const deadline = Date.now() + 5000;
      while (!await check()) { assert.ok(Date.now() < deadline, `lifecycle timeout: ${mode}`); await new Promise(resolve => setTimeout(resolve, 10)); }
    };
    let engine: ReturnType<typeof spawn> | undefined;
    try {
      await post("/session/open", { sessionId: `owner-${mode}` });
      const env = { ...process.env, REACH_WORKSPACE_ROOTS: `default:${root}`, REACH_PROCESS_WORKSPACES: "default", REACH_PROCESS_NODE_BIN: process.env.REACH_TEST_NODE_BIN ?? process.execPath, REACH_PROCESS_STOP_GRACE_MS: "30",
        ...(mode === "lease" ? { REACH_LEASE_SECS: "1" } : {}), ...(mode === "rotation" ? { REACH_ROTATION_SECS: "1" } : {}), ...(mode === "idle" ? { REACH_IDLE_SECS: "1" } : {}) };
      engine = spawn(join(repository, "target/debug/engine"), [url], { env, stdio: "ignore" });
      await waitFor(async () => (await status()).status === "ready");
      await fs.writeFile(join(root, "job.cjs"), "const fs=require('node:fs');setInterval(()=>fs.appendFileSync('ticks','x'),10);");
      const grant = await post("/grants", { kind: "execute", sessionId: `owner-${mode}`, workspace: "default", script: "job.cjs", launchId: "lifecycle" });
      const launched = await post("/session/rpc", { requestId: "run", method: "process.run", params: { workspace: "default", script: "job.cjs", launchId: "lifecycle" }, permission: { grantId: grant.grantId } });
      assert.equal(launched.type, "response", JSON.stringify(launched));
      await waitFor(async () => (await fs.stat(join(root, "ticks")).catch(() => undefined)) !== undefined);
      if (mode === "disconnect") { for (const socket of sockets) socket.destroy(); }
      if (mode === "shutdown") { const exited = once(engine, "exit"); engine.kill("SIGTERM"); assert.equal((await exited)[0], 0); }
      if (mode === "idle") {
        await new Promise(resolve => setTimeout(resolve, 1200));
        assert.equal((await status()).status, "ready");
        await post("/session/close", { sessionId: `owner-${mode}` });
      }
      await waitFor(async () => (await status()).status === "none");
      // On abrupt disconnect Gateway observes closure before Engine drains.
      // Wait for observable task cleanup as well as Gateway ownership release.
      if (mode === "disconnect") await waitFor(async () => {
        const size = (await fs.stat(join(root, "ticks"))).size;
        await new Promise(resolve => setTimeout(resolve, 100));
        return (await fs.stat(join(root, "ticks"))).size === size;
      });
      const bytes = (await fs.stat(join(root, "ticks"))).size;
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal((await fs.stat(join(root, "ticks"))).size, bytes, mode);
    } finally {
      if (engine && engine.exitCode === null) { const exited = once(engine, "exit"); engine.kill("SIGTERM"); await exited; }
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => gateway.close(() => resolve()));
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test("remote HTTP MCP drives a real Rust Engine through revision-safe writes and cleanup", async () => {
  const repository = fileURLToPath(new URL("../../..", import.meta.url));
  const root = await fs.mkdtemp(join(tmpdir(), "reach-http-mcp-"));
  const controllerToken = "c".repeat(48);
  const engineToken = "e".repeat(48);
  const mcpOrigin = "https://client.example.com";
  const gateway = createGateway({ logger: () => {}, heartbeatIntervalSeconds: 1, mcp: { allowedOrigins: [mcpOrigin] }, authentication: { controllerToken, engineToken, engineId: "engine-a" } });
  const sockets = new Set<Socket>();
  gateway.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const address = gateway.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const headers: Record<string, string> = { authorization: `Bearer ${controllerToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
  let engine: ReturnType<typeof spawn> | undefined;
  let sequence = 0;
  const request = async (method: string, params?: unknown, notification = false) => {
    const response = await fetch(`${url}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: ++sequence }), method, params }) });
    if (response.headers.has("mcp-session-id")) headers["mcp-session-id"] = response.headers.get("mcp-session-id")!;
    if (notification) { assert.equal(response.status, 202); return {}; }
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json() as { result: Record<string, any> }).result;
  };
  const tool = (name: string, args: Record<string, unknown> = {}) => request("tools/call", { name, arguments: { deviceId: "engine-a", ...args } });
  const value = (result: Record<string, any>) => { assert.ok(!result.isError, JSON.stringify(result)); return JSON.parse(result.content[0].text); };
  try {
    const build = spawn("cargo", ["build", "--quiet", "--locked", "--offline", "-p", "reach-rpc", "--bin", "engine"], { cwd: repository, stdio: "ignore" });
    assert.equal((await once(build, "exit"))[0], 0);
    const initialized = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "http-integration", version: "1" } });
    assert.equal(initialized.serverInfo.name, "reach-mcp");
    headers["mcp-protocol-version"] = initialized.protocolVersion;
    await request("notifications/initialized", undefined, true);
    assert.equal(value(await tool("pick_device")).status, "connecting");
    engine = spawn(join(repository, "target/debug/engine"), [url], {
      cwd: repository, env: { ...process.env, REACH_ENGINE_ID: "engine-a", REACH_ENGINE_TOKEN: engineToken, REACH_WORKSPACE_ROOTS: `default:${root}`, REACH_PROCESS_WORKSPACES: "default", REACH_PROCESS_NODE_BIN: process.env.REACH_TEST_NODE_BIN ?? process.execPath, REACH_PROCESS_STOP_GRACE_MS: "50" }, stdio: "ignore",
    });
    const deadline = Date.now() + 5_000;
    while (value(await tool("device_status")).status !== "ready") {
      if (Date.now() >= deadline) throw new Error("Engine did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const engineVersion = execFileSync(join(repository, "target/debug/engine"), ["--version"], { encoding: "utf8" }).trim();
    assert.deepEqual(value(await tool("get_versions")), { deviceId: "engine-a", mcpVersion: initialized.serverInfo.version, gatewayVersion: GATEWAY_VERSION, engineVersion });
    const args = { workspace: "default", path: "note.txt" };
    value(await tool("fs_write", { ...args, content: "hello", mode: "create" }));
    const read = value(await tool("fs_read", args));
    assert.equal(read.content, "hello"); assert.match(read.revision, /^[a-f0-9]{64}$/);
    value(await tool("fs_edit", { ...args, oldString: "hello", newString: "updated", ifMatch: read.revision }));
    const stale = await tool("fs_edit", { ...args, oldString: "updated", newString: "wrong", ifMatch: read.revision });
    assert.equal(stale.isError, true); assert.match(stale.content[0].text, /^REVISION_CONFLICT:/);
    assert.equal(value(await tool("fs_read", args)).content, "updated");
    assert.equal(await fs.readFile(join(root, "note.txt"), "utf8"), "updated");
    value(await tool("fs_write", { workspace: "default", path: "job.cjs", mode: "create", content: "console.log('process-ready');setInterval(()=>{},1000)" }));
    const launch = value(await tool("process_run", { workspace: "default", script: "job.cjs", launchId: "http-launch" }));
    assert.ok(launch.processId);
    assert.equal(value(await tool("process_status", { launchId: "http-launch" })).processId, launch.processId);
    assert.equal(value(await tool("process_run", { workspace: "default", script: "job.cjs", launchId: "http-launch" })).processId, launch.processId);
    const logsDeadline = Date.now() + 5000;
    while (!value(await tool("process_logs", { processId: launch.processId })).records.some((r: any) => r.text.includes("process-ready"))) {
      assert.ok(Date.now() < logsDeadline); await new Promise(resolve => setTimeout(resolve, 10));
    }
    value(await tool("process_stop", { processId: launch.processId }));
    while (value(await tool("process_status", { processId: launch.processId })).state !== "stopped") {
      assert.ok(Date.now() < logsDeadline); await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(value(await tool("process_list")).processes.length, 1);
    value(await tool("process_run", { workspace: "default", script: "job.cjs", launchId: "http-close-cleanup" }));
    value(await tool("session_close"));
    assert.equal((await tool("process_status", { processId: launch.processId })).isError, true);
    const status = await fetch(`${url}/session/status`, { headers });
    assert.equal((await status.json() as { status: string }).status, "none");
    // Closing an already closed device must not open another session.
    value(await tool("session_close"));
    assert.equal((await fetch(`${url}/mcp`, { method: "DELETE", headers })).status, 200);
    const deployment = join(root, "deployment.json");
    const verify = async () => {
      const verifier = spawn(process.execPath, [join(repository, "scripts/verify-mcp-http.mjs"), deployment], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
      let diagnostics = "";
      verifier.stdout.on("data", (chunk) => { diagnostics += chunk; });
      verifier.stderr.on("data", (chunk) => { diagnostics += chunk; });
      return { exitCode: (await once(verifier, "exit"))[0], diagnostics };
    };
    await fs.writeFile(deployment, JSON.stringify({ gatewayUrl: url, engineId: "engine-a", controllerToken, mcpOrigin: "https://blocked.example.com" }), { mode: 0o600 });
    const denied = await verify();
    assert.notEqual(denied.exitCode, 0);
    assert.match(denied.diagnostics, /MCP Origin rejected: configure REACH_MCP_ALLOWED_ORIGINS/);
    await fs.writeFile(deployment, JSON.stringify({ gatewayUrl: url, engineId: "engine-a", controllerToken, mcpOrigin }), { mode: 0o600 });
    const verified = await verify();
    assert.equal(verified.exitCode, 0, verified.diagnostics);
    const report = JSON.parse(await fs.readFile(join(root, ".reach/mcp-http-verification.json"), "utf8"));
    assert.equal(report.results.length, 4);
    assert.equal(report.mcpOrigin, mcpOrigin);
  } finally {
    if (engine && engine.exitCode === null) { engine.kill(); await once(engine, "exit"); }
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("MCP drives a real Gateway and Rust Engine through mutation, renewal and close", async () => {
  const repository = fileURLToPath(new URL("../../..", import.meta.url));
  const root = await fs.mkdtemp(join(tmpdir(), "reach-mcp-integration-"));
  const gateway = createGateway({ logger: () => {}, sessionDurationMs: 5_000 });
  const sockets = new Set<Socket>();
  gateway.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const address = gateway.address();
  if (!address || typeof address === "string") throw new Error("Gateway did not bind");
  const gatewayUrl = `http://127.0.0.1:${address.port}`;
  const messages: Record<string, unknown>[] = [];
  const server = new McpServer(loadConfig({ REACH_MCP_DEVICES: JSON.stringify([{ id: "engine", gatewayUrl }]), REACH_MCP_READY_TIMEOUT_MS: "5000", REACH_MCP_READY_POLL_MS: "10" }), (message) => messages.push(message));
  let engine: ReturnType<typeof spawn> | undefined;
  const call = async (id: number, name: string, args: Record<string, unknown>) => {
    await server.receive({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    return messages.find((message) => message.id === id)!.result as { isError?: boolean; content: Array<{ text: string }> };
  };
  try {
    const build = spawn("cargo", ["build", "--quiet", "--locked", "--offline", "-p", "reach-rpc", "--bin", "engine"], { cwd: repository, stdio: "ignore" });
    assert.equal((await once(build, "exit"))[0], 0, "Rust Engine must build");
    const engineVersion = execFileSync(join(repository, "target/debug/engine"), ["--version"], {
      env: { ...process.env, REACH_ENGINE_ID: "" }, encoding: "utf8", timeout: 5000,
    }).trim();
    const manifest = readFileSync(join(repository, "crates/reach-rpc/Cargo.toml"), "utf8");
    assert.equal(engineVersion, manifest.match(/^version = "([^"]+)"/m)![1]);
    await server.receive({ jsonrpc: "2.0", id: 1, method: "initialize" });
    const selecting = call(2, "pick_device", { deviceId: "engine" });
    // Start after open intent is pending, avoiding the 120-second idle interval.
    const pendingDeadline = Date.now() + 3_000;
    while ((await (await fetch(`${gatewayUrl}/session/status`)).json() as { status: string }).status !== "wanted") {
      if (Date.now() >= pendingDeadline) throw new Error("MCP did not request a session");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    engine = spawn(join(repository, "target/debug/engine"), [gatewayUrl], {
      cwd: repository,
      env: { ...process.env, REACH_WORKSPACE_ROOTS: `default:${root}`, REACH_PROCESS_WORKSPACES: "default", REACH_PROCESS_NODE_BIN: process.env.REACH_TEST_NODE_BIN ?? process.execPath, REACH_PROCESS_STOP_GRACE_MS: "50", REACH_LEASE_SECS: "5" },
      stdio: "ignore",
    });
    assert.equal((await selecting).isError, undefined);
    const versions = JSON.parse((await call(7, "get_versions", {})).content[0].text);
    assert.deepEqual(versions, { deviceId: "engine", mcpVersion: MCP_VERSION, gatewayVersion: GATEWAY_VERSION, engineVersion });
    const identity = await (await fetch(`${gatewayUrl}/session/status`)).json() as { sessionId: string };
    assert.equal((await call(6, "fs.write", { workspace: "default", path: "invalid.txt" })).isError, true);
    assert.equal(await fs.stat(join(root, "invalid.txt")).catch(() => undefined), undefined);
    const afterRejection = await (await fetch(`${gatewayUrl}/session/status`)).json() as { status: string; sessionId: string };
    assert.equal(afterRejection.status, "ready");
    assert.equal(afterRejection.sessionId, identity.sessionId);
    const written = await call(3, "fs.write", { workspace: "default", path: "note.txt", content: "hello", mode: "create" });
    assert.equal(written.isError, undefined);
    assert.equal(await fs.readFile(join(root, "note.txt"), "utf8"), "hello");
    const read = await call(4, "fs.read", { workspace: "default", path: "note.txt" });
    assert.equal(JSON.parse(read.content[0].text).content, "hello");
    let processSequence = 100;
    const processCall = async (name: string, args: Record<string, unknown>) => {
      const reply = await call(++processSequence, name, args);
      assert.equal(reply.isError, undefined, JSON.stringify(reply));
      return JSON.parse(reply.content[0].text);
    };
    await processCall("fs.write", { workspace: "default", path: "task.mjs", mode: "create", content: "console.log('stdio-task');setInterval(()=>{},1000)" });
    const task = await processCall("process.run", { workspace: "default", script: "task.mjs", launchId: "stdio-launch" });
    assert.equal((await processCall("process.status", { launchId: "stdio-launch" })).processId, task.processId);
    await processCall("process.stop", { processId: task.processId });
    const stopDeadline = Date.now() + 5000;
    while ((await processCall("process.status", { processId: task.processId })).state !== "stopped") {
      assert.ok(Date.now() < stopDeadline); await new Promise(resolve => setTimeout(resolve, 10));
    }
    await processCall("process.logs", { processId: task.processId });
    await processCall("process.run", { workspace: "default", script: "task.mjs", launchId: "stdio-cleanup" });
    assert.equal((await call(5, "session.close", {})).isError, undefined);
    assert.equal((await (await fetch(`${gatewayUrl}/session/status`)).json() as { status: string }).status, "none");
  } finally {
    await server.shutdown().catch(() => undefined);
    if (engine && engine.exitCode === null) { engine.kill(); await once(engine, "exit"); }
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});
