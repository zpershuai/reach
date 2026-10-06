import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const deployment = JSON.parse(await readFile(".reach/deployment.json", "utf8"));
const installed = JSON.parse(await readFile(process.argv[2] ?? "/Users/perry/.config/reach/mcp.json", "utf8")).mcpServers.reach;
const child = spawn(installed.command, installed.args, { env: { ...process.env, ...installed.env }, stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
let sequence = 0;
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk; });
const exited = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => resolve(code));
});
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  const waiter = pending.get(message.id);
  if (!waiter) return;
  clearTimeout(waiter.timer);
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
  else waiter.resolve(message.result);
});
function request(method, params) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}`)); }, 60000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
async function tool(name, args = {}) {
  const result = await request("tools/call", { name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
}
const probe = `mcp-tests/${randomUUID()}.txt`;
const results = [];
try {
  const initialized = await request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "reach-deployment-verifier", version: "1.0" } });
  assert.equal(initialized.serverInfo.name, "reach-mcp");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  assert.deepEqual((await request("tools/list", {})).tools.map((item) => item.name), ["list_devices", "get_versions", "pick_device"]);
  assert.ok((await tool("list_devices")).devices.some((item) => item.id === deployment.engineId));
  await tool("pick_device", { deviceId: deployment.engineId });
  assert.ok((await request("tools/list", {})).tools.some((item) => item.name === "fs.write"));
  results.push("initialize, list, select and dynamic tools");
  console.log("PASS installed stdio MCP initializes and selects remote Mac Engine");
  await tool("fs.write", { workspace: "default", path: probe, content: "Reach stdio MCP verified", mode: "create" });
  assert.equal((await tool("fs.read", { workspace: "default", path: probe })).content, "Reach stdio MCP verified");
  await tool("fs.edit", { workspace: "default", path: probe, oldString: "verified", newString: "write and edit verified" });
  assert.equal(await readFile(`${deployment.workspaceRoot}/${probe}`, "utf8"), "Reach stdio MCP write and edit verified");
  results.push("stdio MCP write, read, edit and local file proof");
  console.log("PASS installed stdio MCP writes, reads and edits the actual Mac file");
  await tool("session.close");
  assert.deepEqual((await request("tools/list", {})).tools.map((item) => item.name), ["list_devices", "get_versions", "pick_device"]);
  results.push("session close and dynamic tools reset");
  console.log("PASS installed stdio MCP closes its session");
} finally {
  child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGTERM"), 5000);
  const code = await exited;
  clearTimeout(timer);
  assert.equal(code, 0, stderr);
}
await writeFile(".reach/mcp-verification.json", JSON.stringify({ checkedAt: new Date().toISOString(), gatewayUrl: deployment.gatewayUrl, probe, results }, null, 2));
