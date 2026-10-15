import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

async function waitFor<T>(queue: T[], predicate: (item: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const index = queue.findIndex(predicate);
    if (index >= 0) return queue.splice(index, 1)[0];
    if (Date.now() >= deadline) throw new Error("stdio response timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("stdio workspace discovery announces the expanded dynamic tool list", async () => {
  let sessionId: string | undefined;
  let status = "none";
  const gateway = createServer(async (request, response) => {
    if (request.url === "/session/open") {
      let body = "";
      for await (const chunk of request) body += chunk;
      sessionId = (JSON.parse(body) as { sessionId: string }).sessionId;
      status = "ready";
    }
    if (request.url === "/session/close") status = "none";
    const payload = request.url === "/session/status"
      ? { status, sessionId, leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(), workspaces: ["project-notes"], processWorkspaces: [] }
      : request.url === "/session/open"
        ? { wanted: true, status: "wanted" }
        : request.url === "/session/close" ? { status: "none" }
        : { error: "unexpected endpoint" };
    response.writeHead(payload.error ? 404 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const address = gateway.address();
  if (!address || typeof address === "string") throw new Error("mock Gateway did not bind");

  const main = new URL("./main.js", import.meta.url);
  const child = spawn(process.execPath, [fileURLToPath(main)], {
    stdio: "pipe",
    env: {
      ...process.env,
      REACH_MCP_TOOL_MODE: "dynamic",
      REACH_MCP_DEVICES: JSON.stringify([{ id: "proof-device", gatewayUrl: `http://127.0.0.1:${address.port}` }]),
    },
  });
  const messages: Array<Record<string, unknown>> = [];
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => messages.push(JSON.parse(line) as Record<string, unknown>));
  const request = (id: number, method: string, params?: unknown) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`);
  };

  try {
    request(1, "initialize", { protocolVersion: "2025-03-26" });
    const initialized = await waitFor(messages, (message) => message.id === 1);
    assert.deepEqual(((initialized.result as { capabilities: { tools: { listChanged: boolean } } }).capabilities.tools), { listChanged: true });

    request(2, "tools/list");
    const initialList = await waitFor(messages, (message) => message.id === 2);
    const initial = initialList.result as { tools: Array<{ name: string }> };
    assert.ok(initial.tools.some(tool => tool.name === "list_workspaces"));
    assert.equal(initial.tools.some(tool => tool.name === "fs.read"), false);

    request(3, "tools/call", { name: "list_workspaces", arguments: { deviceId: "proof-device" } });
    const discovery = await waitFor(messages, (message) => message.id === 3);
    const discovered = discovery.result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(discovered.isError, undefined);
    assert.deepEqual(JSON.parse(discovered.content[0].text), { deviceId: "proof-device", status: "ready", workspaces: ["project-notes"], processWorkspaces: [] });
    await waitFor(messages, (message) => message.method === "notifications/tools/list_changed");

    request(4, "tools/list");
    const refreshed = await waitFor(messages, (message) => message.id === 4);
    const expanded = refreshed.result as { tools: Array<{ name: string }> };
    assert.ok(expanded.tools.some(tool => tool.name === "fs.read"));
  } finally {
    child.stdin.end();
    await once(child, "exit");
    await new Promise<void>((resolve, reject) => gateway.close((error) => (error ? reject(error) : resolve())));
  }
});
