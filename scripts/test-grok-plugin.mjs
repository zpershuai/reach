import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./configure-grok-plugin.mjs", import.meta.url));

async function withDeployment(config, check) {
  const root = await mkdtemp(join(tmpdir(), "reach-grok-plugin-"));
  const configFile = join(root, "deployment.json");
  await writeFile(configFile, JSON.stringify(config));
  const run = () => spawnSync(process.execPath, [script, configFile], { cwd: root, encoding: "utf8", timeout: 5000 });
  try { await check(root, run); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("Grok plugin uses a literal HTTPS endpoint and keeps credentials in the host prompt", async () => {
  const token = "private-controller-token-for-test";
  await withDeployment({ gatewayUrl: "https://gateway.example.com:8443/", controllerToken: token }, async (root, run) => {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    const output = join(root, ".reach/grok-bot-plugin");
    const mcpText = await readFile(join(output, "mcp.json"), "utf8");
    const mcp = JSON.parse(mcpText).mcpServers.reach;
    assert.equal(mcp.url, "https://gateway.example.com:8443/mcp");
    assert.equal(mcp.headers.Authorization, "Bearer ${REACH_CONTROLLER_TOKEN}");
    const manifestText = await readFile(join(output, ".cursor-plugin/plugin.json"), "utf8");
    const manifest = JSON.parse(manifestText);
    assert.deepEqual(manifest.variables.required, ["REACH_CONTROLLER_TOKEN"]);
    assert.ok(!manifest.variables.properties.REACH_GATEWAY_URL);
    assert.ok(!(mcpText + manifestText + result.stdout + result.stderr).includes(token));
    assert.ok((await stat(join(output, "assets/logo.svg"))).isFile());
    assert.ok((await stat(join(output, "skills/reach-files/SKILL.md"))).isFile());
    assert.equal((await stat(output)).mode & 0o777, 0o700);
    assert.equal((await stat(join(output, "mcp.json"))).mode & 0o777, 0o600);
  });
});

test("Grok plugin rejects ambiguous or non-public URLs before creating an installation", async () => {
  for (const gatewayUrl of [undefined, "http://gateway.example.com", "https://localhost", "https://127.0.0.1", "https://[::1]", "https://user:secret@gateway.example.com", "https://gateway.example.com/mcp", "https://gateway.example.com?token=secret", "https://gateway.example.com#secret", "${REACH_GATEWAY_URL}"]) {
    await withDeployment({ gatewayUrl }, async (root, run) => {
      const result = run();
      assert.notEqual(result.status, 0, String(gatewayUrl));
      await assert.rejects(stat(join(root, ".reach/grok-bot-plugin")), { code: "ENOENT" });
    });
  }
});

test("Grok plugin refuses to overwrite an existing private installation", async () => {
  await withDeployment({ gatewayUrl: "https://gateway.example.com" }, async (root, run) => {
    assert.equal(run().status, 0);
    const path = join(root, ".reach/grok-bot-plugin/mcp.json");
    await writeFile(path, "private customization\n");
    const result = run();
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(path, "utf8"), "private customization\n");
  });
});
