import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Run from the repository root; deployment details stay in ignored .reach/.
const config = JSON.parse(await readFile(process.argv[2] ?? ".reach/deployment.json", "utf8"));
assert.equal(typeof config.gatewayUrl, "string", "gatewayUrl is required");
const gateway = new URL(config.gatewayUrl);
assert.ok(gateway.protocol === "https:" && !gateway.username && !gateway.password
  && !gateway.search && !gateway.hash && gateway.pathname === "/", "Use a public HTTPS Gateway root without credentials, path, query or fragment");
assert.ok(!["localhost", "127.0.0.1", "[::1]"].includes(gateway.hostname), "Grok Bot requires a public Gateway, not localhost");

const source = fileURLToPath(new URL("../grok-bot-plugin/", import.meta.url));
const output = resolve(".reach/grok-bot-plugin");
const mcp = JSON.parse(await readFile(resolve(source, "mcp.json"), "utf8"));
mcp.mcpServers.reach.url = `${gateway.origin}/mcp`;
await mkdir(".reach", { recursive: true, mode: 0o700 });
// Refuse to replace an existing private plugin or its local customizations.
await mkdir(output, { mode: 0o700 });
for (const name of [".cursor-plugin", "assets", "skills", "README.md"]) {
  await cp(resolve(source, name), resolve(output, name), { recursive: true });
}
await writeFile(resolve(output, "mcp.json"), JSON.stringify(mcp, null, 2) + "\n", { mode: 0o600 });
console.log("Private plugin created at .reach/grok-bot-plugin. Install that folder and enter REACH_CONTROLLER_TOKEN through the host's private setup prompt.");
