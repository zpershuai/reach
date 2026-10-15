import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, cpSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const source = new URL("../packages/grok-bot-mcp-connector/", import.meta.url);
const root = mkdtempSync(join(tmpdir(), "reach-mcp-dist-"));
try {
  cpSync(new URL("dist/", source), join(root, "dist"), { recursive: true });
  cpSync(new URL("package.json", source), join(root, "package.json"));
  writeFileSync(join(root, "devices.json"), JSON.stringify([{ id: "fixture", gatewayUrl: "http://127.0.0.1:8787" }]));
  const version = JSON.parse(readFileSync(new URL("package.json", source))).version;
  const messages = [{ jsonrpc: "2.0", id: 1, method: "initialize" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_versions", arguments: {} } }];
  const result = spawnSync(process.execPath, [join(root, "dist/main.js")], { cwd: root, env: { ...process.env, REACH_MCP_TOOL_MODE: "dynamic", REACH_MCP_DEVICES: "", REACH_MCP_DEVICES_FILE: join(root, "devices.json") }, input: messages.map(JSON.stringify).join("\n") + "\n", encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const replies = result.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(replies[0].result.serverInfo.version, version);
  assert.equal(JSON.parse(replies[2].result.content[0].text).mcpVersion, version);
  const cli = spawnSync(process.execPath, [join(root, "dist/main.js"), "--version"], { cwd: root, encoding: "utf8", timeout: 5000 });
  assert.equal(cli.status, 0, cli.stderr);
  assert.ok(cli.stdout.includes(version));
  console.log("Standalone MCP distribution initializes, lists tools and reports its version.");
} finally { rmSync(root, { recursive: true, force: true }); }
