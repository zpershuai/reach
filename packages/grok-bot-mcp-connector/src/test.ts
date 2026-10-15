import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { GatewayHttpError, SessionReplacedError, type SessionStatus } from "./gateway.js";
import { McpServer, MCP_PROTOCOL_VERSION } from "./server.js";
import { MCP_VERSION } from "./version.js";

function readyGateway(overrides: Partial<{
  rpc: (method: string, params: Record<string, unknown>, permission?: { grantId: string }) => Promise<Record<string, unknown>>;
  renew: () => Promise<{ leaseExpiresAt?: string }>;
  grant: (workspace: string, path: string, method: "fs.write" | "fs.edit") => Promise<{ grantId: string }>;
  close: () => Promise<void>;
  status: () => Promise<SessionStatus>;
}> = {}) {
  return {
    status: overrides.status ?? (async () => ({ status: "ready", leaseExpiresAt: new Date(Date.now() + 30_000).toISOString() })),
    openAndWait: async () => ({ leaseExpiresAt: new Date(Date.now() + 30_000).toISOString() }),
    renew: overrides.renew ?? (async () => ({ leaseExpiresAt: new Date(Date.now() + 300_000).toISOString() })),
    rpc: overrides.rpc ?? (async (method: string, params: Record<string, unknown>) => ({ type: "response", result: { method, params } })),
    grant: overrides.grant ?? (async () => ({ grantId: "issued-grant" })),
    close: overrides.close ?? (async () => {}),
  };
}

function testServer() {
  const messages: Record<string, unknown>[] = [];
  const server = new McpServer(loadConfig({}), (message) => messages.push(message));
  return { server, messages };
}

test("workspace discovery selects the Engine before file access in dynamic and static modes", async () => {
  for (const toolMode of ["dynamic", "static"] as const) {
    const messages: Record<string, unknown>[] = [];
    const lifecycle: string[] = [];
    const metadata = { sessionId: "workspace-owner", workspaces: ["project-notes", "automation"], processWorkspaces: ["automation"] };
    const server = new McpServer({ ...loadConfig({}), toolMode }, message => messages.push(message), () => ({
      ...readyGateway(),
      openAndWait: async () => { lifecycle.push("open"); return metadata; },
      status: async () => ({ status: "ready", ...metadata }),
      rpc: async (method, params) => {
        lifecycle.push(method);
        assert.deepEqual(params, { workspace: "project-notes", path: "note.txt" });
        return { type: "response", result: { content: "discovered workspace" } };
      },
    }));
    await server.receive({ jsonrpc: "2.0", id: 1, method: "initialize" });
    await server.receive({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    // These messages are produced by the in-process server after the awaited request completes.
    const initial = messages.at(-1)!.result as { tools: Array<{ name: string }> };
    assert.ok(initial.tools.some(tool => tool.name === "list_workspaces"));
    assert.equal(initial.tools.some(tool => tool.name === "fs.read"), toolMode === "static");
    await server.receive({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_workspaces", arguments: { deviceId: "local-engine" } } });
    const discovered = messages.find(message => message.id === 3)!.result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(discovered.isError, undefined);
    const workspaces = JSON.parse(discovered.content[0].text);
    assert.deepEqual(workspaces, { deviceId: "local-engine", status: "ready", workspaces: metadata.workspaces, processWorkspaces: metadata.processWorkspaces });
    assert.deepEqual(lifecycle, ["open"], "discovery uses ready metadata without an Engine RPC");
    assert.equal(messages.filter(message => message.method === "notifications/tools/list_changed").length, toolMode === "dynamic" ? 1 : 0);
    await server.receive({ jsonrpc: "2.0", id: 4, method: "tools/list" });
    const refreshed = messages.at(-1)!.result as { tools: Array<{ name: string }> };
    assert.ok(refreshed.tools.some(tool => tool.name === "fs.read"));
    await server.receive({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "fs.read", arguments: {
      ...(toolMode === "static" ? { deviceId: "local-engine" } : {}), workspace: workspaces.workspaces[0], path: "note.txt",
    } } });
    const read = messages.find(message => message.id === 5)!.result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(read.isError, undefined);
    assert.deepEqual(JSON.parse(read.content[0].text), { content: "discovered workspace" });
    assert.deepEqual(lifecycle, ["open", "fs.read"], "file access reuses the discovery session");
  }
});

test("workspace discovery distinguishes missing metadata from empty workspaces and older execution metadata", async () => {
  const messages: Record<string, unknown>[] = [];
  let metadata: { sessionId: string; workspaces?: string[]; processWorkspaces?: string[] } = { sessionId: "owner" };
  let opens = 0;
  const server = new McpServer(loadConfig({}), message => messages.push(message), () => ({
    ...readyGateway(),
    openAndWait: async () => { opens++; return metadata; },
    status: async () => ({ status: "ready", ...metadata }),
    rpc: async () => { throw new Error("workspace discovery must not invoke an Engine RPC"); },
  }));
  await server.receive({ jsonrpc: "2.0", id: 1, method: "initialize" });
  let sequence = 1;
  const discover = async (args: unknown) => {
    const id = ++sequence;
    await server.receive({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "list_workspaces", arguments: args } });
    return messages.find(message => message.id === id)!.result as { isError?: boolean; content: Array<{ text: string }> };
  };
  for (const args of [undefined, null, [], {}, { deviceId: 123 }, { deviceId: "unknown" }]) assert.equal((await discover(args)).isError, true);
  assert.equal(opens, 0);
  const unavailable = await discover({ deviceId: "local-engine" });
  assert.equal(unavailable.isError, true);
  assert.match(unavailable.content[0].text, /^WORKSPACES_UNAVAILABLE:/);
  for (const workspaces of [[], ["project-notes"]]) {
    metadata = { sessionId: "owner", workspaces };
    const result = await discover({ deviceId: "local-engine" });
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), { deviceId: "local-engine", status: "ready", workspaces, processWorkspaces: [] });
  }
  assert.equal(opens, 1, "discovery refreshes metadata without replacing the owned session");
});

test("static close never selects another device or wakes an offline device and preserves owned tasks", async () => {
  const config = loadConfig({ REACH_MCP_TOOL_MODE: "static", REACH_MCP_DEVICES: JSON.stringify([{ id: "a", gatewayUrl: "http://127.0.0.1:8787" }, { id: "b", gatewayUrl: "http://127.0.0.1:8788" }]) });
  const messages: Record<string, unknown>[] = [];
  const lifecycle: string[] = [];
  let replaced = false;
  const server = new McpServer(config, message => messages.push(message), device => {
    assert.equal(device.id, "a", "closing an unowned/offline device must not even create a client");
    return {
      ...readyGateway(),
      openAndWait: async () => { lifecycle.push("open(a)"); return { sessionId: "owner", methods: ["process.status"] }; },
      status: async () => ({ status: "ready", sessionId: replaced ? "successor" : "owner", methods: ["process.status"] }),
      rpc: async () => ({ type: "response", result: { processId: "running-task" } }),
      close: async () => { lifecycle.push("close(a)"); if (replaced) throw new SessionReplacedError(); },
    };
  });
  let sequence = 0;
  const call = async (name: string, deviceId: string) => {
    const id = ++sequence;
    await server.receive({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { deviceId, launchId: "launch" } } });
    return messages.find(message => message.id === id)!.result as { isError?: boolean; content: Array<{ text: string }> };
  };
  await server.receive({ jsonrpc: "2.0", id: "init", method: "initialize" });
  assert.equal((await call("pick_device", "a")).isError, undefined);
  assert.deepEqual(JSON.parse((await call("session.close", "b")).content[0].text), { closedDeviceId: "b", closed: false, owned: false });
  assert.deepEqual(lifecycle, ["open(a)"]);
  assert.equal((await call("process.status", "a")).isError, undefined);
  assert.deepEqual(lifecycle, ["open(a)"]);
  replaced = true;
  assert.match((await call("session.close", "a")).content[0].text, /ENGINE_BUSY/);
  assert.deepEqual(lifecycle, ["open(a)", "close(a)"]);
  assert.deepEqual(JSON.parse((await call("session.close", "a")).content[0].text), { closedDeviceId: "a", closed: false, owned: false });
  assert.deepEqual(lifecycle, ["open(a)", "close(a)"]);
});

test("process launch deadlines preserve identity and observation never replaces a session", async () => {
  for (const toolMode of ["dynamic", "static"] as const) {
    const messages: Record<string, unknown>[] = [];
    let ready = true;
    let opens = 0;
    let runs = 0;
    const status = async () => ({ status: ready ? "ready" : "none", sessionId: ready ? "owner" : undefined, methods: ["process.run", "process.status"] });
    const server = new McpServer({ ...loadConfig({}), toolMode }, message => messages.push(message), () => ({
      ...readyGateway(), status,
      openAndWait: async () => { opens++; return { sessionId: "owner" }; },
      processGrant: async () => ({ grantId: "execution", kind: "execute" as const }),
      rpc: async method => {
        if (method === "process.run") { runs++; return { type: "error", error: { code: "DEADLINE_EXCEEDED" } }; }
        return { type: "response", result: { processId: "task", launchId: "launch" } };
      },
    }));
    let sequence = 0;
    const call = async (name: string, args: Record<string, unknown>) => {
      const id = ++sequence;
      await server.receive({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: toolMode === "static" ? { deviceId: "local-engine", ...args } : args } });
      return messages.find(message => message.id === id)!.result as { isError?: boolean; content: Array<{ text: string }> };
    };
    await server.receive({ jsonrpc: "2.0", id: "init", method: "initialize" });
    await call("pick_device", { deviceId: "local-engine" });
    const result = await call("process.run", { workspace: "default", script: "main.cjs", launchId: "launch" });
    assert.equal(result.isError, true); assert.match(result.content[0].text, /launchId=launch/); assert.match(result.content[0].text, /PROCESS_NOT_FOUND.*same launchId and identical parameters/); assert.equal(runs, 1);
    assert.equal((await call("process.status", { launchId: "launch" })).isError, undefined);
    ready = false;
    assert.equal((await call("process.status", { launchId: "launch" })).isError, true);
    assert.equal(opens, 1);
  }
});

test("older Engines reject process capability without forwarding or obtaining grants", async () => {
  const messages: Record<string, unknown>[] = [];
  let calls = 0;
  const server = new McpServer(loadConfig({}), message => messages.push(message), () => readyGateway({ rpc: async () => { calls++; return {}; } }));
  await server.receive({ jsonrpc: "2.0", id: 1, method: "initialize" });
  await server.receive({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "pick_device", arguments: { deviceId: "local-engine" } } });
  await server.receive({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "process.run", arguments: { workspace: "default", script: "main.js", launchId: "launch" } } });
  const result = messages.find(message => message.id === 3)!.result as { isError: boolean; content: Array<{ text: string }> };
  assert.equal(result.isError, true); assert.match(result.content[0].text, /PROCESS_UNSUPPORTED/); assert.equal(calls, 0);
});

test("MCP CLI reports its package version without loading private configuration or starting stdio", () => {
  const output = execFileSync(process.execPath, [fileURLToPath(new URL("./main.js", import.meta.url)), "--version"], {
    env: { ...process.env, REACH_MCP_DEVICES: "invalid" }, encoding: "utf8", timeout: 5000,
  });
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(output.trim(), manifest.version);
  assert.equal(MCP_VERSION, manifest.version);
});

test("standalone MCP keeps its built version when the package manifest changes without rebuilding", () => {
  const directory = mkdtempSync(join(tmpdir(), "reach-mcp-version-"));
  try {
    mkdirSync(join(directory, "dist"));
    writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module", version: "9.9.9" }));
    for (const file of ["main.js", "config.js", "gateway.js", "server.js", "tools.js", "protocol.js", "invoker.js", "result.js", "version.js", "version.json"]) {
      copyFileSync(new URL(file, import.meta.url), join(directory, "dist", file));
    }
    const output = execFileSync(process.execPath, [join(directory, "dist/main.js"), "--version"], { encoding: "utf8", timeout: 5000 });
    assert.equal(output.trim(), MCP_VERSION);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("get_versions observes configured devices without opening, closing or selecting a session", async () => {
  const messages: Record<string, unknown>[] = [];
  let status: SessionStatus = { status: "none", gatewayVersion: "2.0.0", engineVersion: "1.2.3" };
  let queries = 0;
  const server = new McpServer(loadConfig({}), (message) => messages.push(message), () => ({
    ...readyGateway(),
    status: async () => { queries++; return status; },
    openAndWait: async () => { throw new Error("must not open"); },
    close: async () => { throw new Error("must not close"); },
  }));
  await server.receive({ jsonrpc: "2.0", id: 1, method: "initialize" });
  const query = async (argumentsValue?: unknown) => {
    await server.receive({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_versions", arguments: argumentsValue } });
    return messages.at(-1)!.result as { content: Array<{ text: string }>; isError?: boolean };
  };
  assert.deepEqual(JSON.parse((await query()).content[0].text), { mcpVersion: MCP_VERSION, gatewayVersion: null, engineVersion: null });
  assert.equal(queries, 0);
  assert.equal((await query({ deviceId: "unknown" })).isError, true);
  assert.equal((await query({ deviceId: 123 })).isError, true);
  assert.deepEqual(JSON.parse((await query({ deviceId: "local-engine" })).content[0].text), {
    mcpVersion: MCP_VERSION, deviceId: "local-engine", gatewayVersion: "2.0.0", engineVersion: "1.2.3",
  });
  status = { status: "none" };
  assert.deepEqual(JSON.parse((await query({ deviceId: "local-engine" })).content[0].text), {
    mcpVersion: MCP_VERSION, deviceId: "local-engine", gatewayVersion: null, engineVersion: null,
  });
  await server.shutdown();
});

test("initialize declares tools.listChanged", async () => {
  const { server, messages } = testServer();
  await server.receive({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_PROTOCOL_VERSION } });
  const result = messages[0].result as { protocolVersion: string; capabilities: unknown; serverInfo: unknown; instructions: string };
  assert.equal(result.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.deepEqual(result.capabilities, { tools: { listChanged: true } });
  assert.deepEqual(result.serverInfo, { name: "reach-mcp", version: MCP_VERSION });
  assert.match(result.instructions, /Call list_workspaces with a deviceId before using filesystem or process tools/);
});

test("tools require initialization and requests receive structured replies", async () => {
  const { server, messages } = testServer();
  await server.receive({ jsonrpc: "2.0", id: "before", method: "tools/list" });
  await server.receive({ jsonrpc: "2.0", id: "missing", method: "not/a/method" });
  assert.equal((messages[0].error as { code: number }).code, -32603);
  assert.equal((messages[1].error as { code: number }).code, -32603);
});

test("initialized is an accepted notification", async () => {
  const { server, messages } = testServer();
  await server.receive({ jsonrpc: "2.0", id: 1, method: "initialize" });
  await server.receive({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(messages.length, 1);
});

test("only configured devices can be picked after their Gateway is ready", async () => {
  const config = loadConfig({ REACH_MCP_DEVICES: JSON.stringify([{ id: "remote", gatewayUrl: "http://127.0.0.1:8787" }]) });
  const messages: Record<string, unknown>[] = [];
  let opened = 0;
  const server = new McpServer(config, (message) => messages.push(message), () => ({
    ...readyGateway(),
    openAndWait: async () => {
      opened += 1;
      return { leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() };
    },
  }));
  await server.receive({ jsonrpc: "2.0", id: 1, method: "initialize" });
  await server.receive({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const initial = messages[1].result as { tools: Array<{ name: string }> };
  assert.equal(initial.tools.some(tool => tool.name === "fs.read"), false);
  await server.receive({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "pick_device", arguments: { deviceId: "missing" } } });
  assert.equal((messages[2].result as { isError: boolean }).isError, true);
  await server.receive({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "pick_device", arguments: { deviceId: "remote" } } });
  assert.equal(opened, 1);
  assert.deepEqual(JSON.parse((((messages[3].result as { content: Array<{ text: string }> }).content)[0].text)), { selectedDeviceId: "remote", status: "ready" });
  assert.deepEqual(messages[4], { jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  await server.receive({ jsonrpc: "2.0", id: 5, method: "tools/list" });
  const refreshed = (messages[5].result as { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> }).tools;
  assert.equal("deviceId" in refreshed.find((tool) => tool.name === "fs.read")!.inputSchema.properties, false);
});

test("filesystem calls renew then forward through the selected Gateway and close clears selection", async () => {
  const config = loadConfig({ REACH_MCP_RENEW_SKEW_MS: "60000" });
  const messages: Record<string, unknown>[] = [];
  const calls: string[] = [];
  const server = new McpServer(config, (message) => messages.push(message), () => readyGateway({
    renew: async () => {
      calls.push("renew");
      return { leaseExpiresAt: new Date(Date.now() + 300_000).toISOString() };
    },
    rpc: async (method, params) => {
      calls.push(`rpc:${method}`);
      return { type: "response", result: { remote: true, params } };
    },
    close: async () => { calls.push("close"); },
  }));
  await server.receive({ jsonrpc: "2.0", id: 1, method: "initialize" });
  await server.receive({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "pick_device", arguments: { deviceId: "local-engine" } } });
  await server.receive({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fs.read", arguments: { workspace: "default", path: "note.txt" } } });
  assert.deepEqual(calls.slice(0, 2), ["renew", "rpc:fs.read"]);
  assert.deepEqual(JSON.parse((((messages[3].result as { content: Array<{ text: string }> }).content)[0].text)), { remote: true, params: { workspace: "default", path: "note.txt" } });
  await server.receive({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "session.close", arguments: {} } });
  assert.equal(calls[2], "close");
  await server.receive({ jsonrpc: "2.0", id: 5, method: "tools/list" });
  const afterClose = messages[6].result as { tools: Array<{ name: string }> };
  assert.equal(afterClose.tools.some(tool => tool.name === "fs.read"), false);
});

test("writes obtain a matching Gateway grant before forwarding permission", async () => {
  const messages: Record<string, unknown>[] = [];
  const calls: string[] = [];
  const server = new McpServer(loadConfig({}), (message) => messages.push(message), () => readyGateway({
    grant: async (workspace, path, method) => {
      calls.push(`grant:${method}:${workspace}:${path}`);
      return { grantId: "gateway-issued" };
    },
    rpc: async (method, _params, permission) => {
      calls.push(`rpc:${method}:${permission?.grantId}`);
      return { type: "response", result: { written: true } };
    },
  }));
  await server.receive({ jsonrpc: "2.0", id: 1, method: "initialize" });
  await server.receive({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "pick_device", arguments: { deviceId: "local-engine" } } });
  await server.receive({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fs.write", arguments: { workspace: "default", path: "note.txt", content: "hello", mode: "overwrite" } } });
  assert.deepEqual(calls, ["grant:fs.write:default:note.txt", "rpc:fs.write:gateway-issued"]);
  assert.equal((messages[3].result as { isError?: boolean }).isError, undefined);
});

test("static compatibility mode advertises deviceId and opens that configured device per tool call", async () => {
  const config = loadConfig({ REACH_MCP_TOOL_MODE: "static" });
  const messages: Record<string, unknown>[] = [];
  const calls: string[] = [];
  const server = new McpServer(config, (message) => messages.push(message), () => readyGateway({
    rpc: async (method, params) => {
      calls.push(`${method}:${params.path}`);
      return { type: "response", result: { ok: true } };
    },
  }));
  await server.receive({ jsonrpc: "2.0", id: 1, method: "initialize" });
  await server.receive({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tools = (messages[1].result as { tools: Array<{ name: string; inputSchema: { required: string[] } }> }).tools;
  assert.ok(tools.some((tool) => tool.name === "fs.read"));
  assert.ok(tools.find((tool) => tool.name === "session.close")!.inputSchema.required.includes("deviceId"));
  await server.receive({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fs.read", arguments: { deviceId: "local-engine", workspace: "default", path: "note.txt" } } });
  assert.deepEqual(calls, ["fs.read:note.txt"]);
});


test("expired selections reopen before RPC and switching drains the old device", async () => {
  const config = loadConfig({ REACH_MCP_DEVICES: JSON.stringify([{ id: "a", gatewayUrl: "http://127.0.0.1:8787" }, { id: "b", gatewayUrl: "http://127.0.0.1:8788" }]) });
  const messages: Record<string, unknown>[] = [];
  const calls: string[] = [];
  let expired = false;
  const server = new McpServer(config, (message) => messages.push(message), (device) => ({
    ...readyGateway(),
    openAndWait: async () => { calls.push(`open:${device.id}`); expired = false; return {}; },
    status: async () => ({ status: expired ? "none" : "ready" }),
    close: async () => { calls.push(`close:${device.id}`); },
    rpc: async () => { calls.push(`rpc:${device.id}`); return { type: "response", result: {} }; },
  }));
  await server.receive({ jsonrpc: "2.0", id: 1, method: "initialize" });
  await server.receive({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "pick_device", arguments: { deviceId: "a" } } });
  expired = true;
  await server.receive({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fs.read", arguments: {} } });
  await server.receive({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "pick_device", arguments: { deviceId: "b" } } });
  assert.deepEqual(calls, ["open:a", "close:a", "open:a", "rpc:a", "close:a", "open:b"]);
  await server.shutdown();
  assert.equal(calls.at(-1), "close:b");
});

test("an uncertain write is sent once and removes stale dynamic tools", async () => {
  const messages: Record<string, unknown>[] = [];
  let writes = 0;
  let closed = 0;
  const server = new McpServer(loadConfig({}), (message) => messages.push(message), () => readyGateway({
    rpc: async () => { writes += 1; throw new Error("connection lost after commit"); },
    close: async () => { closed += 1; },
  }));
  await server.receive({ jsonrpc: "2.0", id: 1, method: "initialize" });
  await server.receive({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "pick_device", arguments: { deviceId: "local-engine" } } });
  await server.receive({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fs.write", arguments: { workspace: "default", path: "note.txt", content: "x", mode: "overwrite" } } });
  assert.equal(writes, 1);
  assert.equal(closed, 1);
  assert.equal((messages.find((message) => message.id === 3)!.result as { isError: boolean }).isError, true);
  await server.receive({ jsonrpc: "2.0", id: 4, method: "tools/list" });
  const afterFailure = messages.at(-1)!.result as { tools: Array<{ name: string }> };
  assert.equal(afterFailure.tools.some(tool => tool.name === "fs.read"), false);
});

test("a failed status check drains ownership before selecting the device again", async () => {
  const messages: Record<string, unknown>[] = [];
  let active = false;
  let failStatus = true;
  let opens = 0;
  let closes = 0;
  let rpcs = 0;
  const server = new McpServer(loadConfig({}), (message) => messages.push(message), () => ({
    ...readyGateway({
      status: async () => {
        if (failStatus) { failStatus = false; throw new Error("status unavailable"); }
        return { status: "ready", sessionId: "owned" };
      },
      close: async () => { closes += 1; active = false; },
      rpc: async () => { rpcs += 1; return { type: "response", result: {} }; },
    }),
    openAndWait: async () => {
      assert.equal(active, false, "a live session must drain before another open");
      active = true;
      opens += 1;
      return { sessionId: "owned" };
    },
  }));
  await server.receive({ jsonrpc: "2.0", id: 1, method: "initialize" });
  await server.receive({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "pick_device", arguments: { deviceId: "local-engine" } } });
  await server.receive({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fs.read", arguments: {} } });
  assert.equal((messages.find((message) => message.id === 3)!.result as { isError: boolean }).isError, true);
  assert.equal(closes, 1);
  assert.equal(rpcs, 0);
  await server.receive({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "pick_device", arguments: { deviceId: "local-engine" } } });
  assert.equal(opens, 2);
});

test("failed drains hide tools but retain the old owner until a later switch succeeds", async () => {
  const config = loadConfig({ REACH_MCP_DEVICES: JSON.stringify([{ id: "a", gatewayUrl: "http://127.0.0.1:8787" }, { id: "b", gatewayUrl: "http://127.0.0.1:8788" }]) });
  const messages: Record<string, unknown>[] = [];
  const calls: string[] = [];
  let failClose = true;
  const server = new McpServer(config, (message) => messages.push(message), (device) => ({
    ...readyGateway({ close: async () => {
      calls.push(`close:${device.id}`);
      if (failClose) throw new Error("close unavailable");
    } }),
    openAndWait: async () => { calls.push(`open:${device.id}`); return {}; },
  }));
  await server.receive({ jsonrpc: "2.0", id: 1, method: "initialize" });
  await server.receive({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "pick_device", arguments: { deviceId: "a" } } });
  await server.receive({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "pick_device", arguments: { deviceId: "b" } } });
  assert.deepEqual(calls, ["open:a", "close:a", "close:a"]);
  await server.receive({ jsonrpc: "2.0", id: 4, method: "tools/list" });
  const afterFailure = messages.at(-1)!.result as { tools: Array<{ name: string }> };
  assert.equal(afterFailure.tools.some(tool => tool.name === "fs.read"), false);
  failClose = false;
  await server.receive({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "pick_device", arguments: { deviceId: "b" } } });
  assert.deepEqual(calls, ["open:a", "close:a", "close:a", "close:a", "open:b"]);
});

test("an explicit failed close remains drainable on the next selection", async () => {
  let closes = 0;
  let opens = 0;
  const messages: Record<string, unknown>[] = [];
  const server = new McpServer(loadConfig({}), (message) => messages.push(message), () => ({
    ...readyGateway({ close: async () => {
      closes += 1;
      if (closes <= 2) throw new Error("close unavailable");
    } }),
    openAndWait: async () => { opens += 1; return {}; },
  }));
  await server.receive({ jsonrpc: "2.0", id: 1, method: "initialize" });
  await server.receive({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "pick_device", arguments: { deviceId: "local-engine" } } });
  await server.receive({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "session.close", arguments: {} } });
  assert.equal((messages.find((message) => message.id === 3)!.result as { isError: boolean }).isError, true);
  await server.receive({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "pick_device", arguments: { deviceId: "local-engine" } } });
  assert.equal(closes, 3);
  assert.equal(opens, 2);
});

test("a request deadline does not discard a healthy selected session", async () => {
  let opens = 0;
  let closes = 0;
  let rpcs = 0;
  const server = new McpServer(loadConfig({}), () => {}, () => ({
    ...readyGateway({
      close: async () => { closes += 1; },
      rpc: async () => {
        rpcs += 1;
        return rpcs === 1 ? { type: "error", error: { code: "DEADLINE_EXCEEDED" } } : { type: "response", result: {} };
      },
    }),
    openAndWait: async () => { opens += 1; return {}; },
  }));
  await server.receive({ jsonrpc: "2.0", id: 1, method: "initialize" });
  await server.receive({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "pick_device", arguments: { deviceId: "local-engine" } } });
  for (const id of [3, 4]) await server.receive({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "fs.read", arguments: {} } });
  assert.equal(rpcs, 2);
  assert.equal(opens, 1);
  assert.equal(closes, 0);
});

test("confirmed ownership loss releases the stale reference without blocking another device", async () => {
  const config = loadConfig({ REACH_MCP_DEVICES: JSON.stringify([{ id: "a", gatewayUrl: "http://127.0.0.1:8787" }, { id: "b", gatewayUrl: "http://127.0.0.1:8788" }]) });
  const opened: string[] = [];
  let closes = 0;
  const server = new McpServer(config, () => {}, (device) => ({
    ...readyGateway({ close: async () => { closes += 1; throw new SessionReplacedError(); } }),
    openAndWait: async () => { opened.push(device.id); return {}; },
  }));
  await server.receive({ jsonrpc: "2.0", id: 1, method: "initialize" });
  await server.receive({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "pick_device", arguments: { deviceId: "a" } } });
  for (const id of [3, 4]) await server.receive({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "pick_device", arguments: { deviceId: "b" } } });
  assert.deepEqual(opened, ["a", "b"]);
  assert.equal(closes, 2);
});

test("known HTTP request rejections preserve the session but uncertain failures drain it", async () => {
  for (const [status, message, rejected] of [
    [400, "INVALID_PARAMS", true], [413, "invalid rpc payload", true],
    [409, "duplicate requestId", true], [503, "too many pending rpcs", true],
    [503, "session rpc timeout", false], [409, "no live session", false],
  ] as const) {
    const messages: Record<string, unknown>[] = [];
    let closes = 0;
    let rpcs = 0;
    const server = new McpServer(loadConfig({}), (reply) => messages.push(reply), () => readyGateway({
      close: async () => { closes += 1; },
      rpc: async () => {
        rpcs += 1;
        if (rpcs === 1) throw new GatewayHttpError("/session/rpc", status, message);
        return { type: "response", result: {} };
      },
    }));
    await server.receive({ jsonrpc: "2.0", id: 1, method: "initialize" });
    await server.receive({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "pick_device", arguments: { deviceId: "local-engine" } } });
    await server.receive({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fs.read", arguments: {} } });
    assert.equal(closes, rejected ? 0 : 1, `${status}: ${message}`);
    assert.equal(rpcs, 1, "the rejected request is never automatically replayed");
    await server.receive({ jsonrpc: "2.0", id: 4, method: "tools/list" });
    assert.equal((messages.at(-1)!.result as { tools: Array<{ name: string }> }).tools.some((tool) => tool.name === "fs.read"), rejected);
    if (rejected) {
      await server.receive({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "fs.read", arguments: {} } });
      assert.equal(rpcs, 2);
    }
  }
});
