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
      env: { ...process.env, REACH_WORKSPACE_ROOTS: `default:${root}`, REACH_LEASE_SECS: "5" },
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
