import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { createGateway } from "../gateway.js";
import { parseConsoleConfig } from "./config.js";

test("console configuration parses all variables and requires an origin on a public bind", () => {
  assert.equal(parseConsoleConfig({}, "0.0.0.0", 8787), undefined);
  assert.deepEqual(parseConsoleConfig({
    REACH_DATA_DIR: "/tmp/reach-data", REACH_PUBLIC_ORIGIN: "https://gateway.example.com",
    REACH_ADMIN_SETUP_TOKEN: "setup-token", REACH_TRUSTED_PROXIES: "192.0.2.1, 198.51.100.0/24",
    REACH_AUDIT_RETENTION_DAYS: "90",
  }, "0.0.0.0", 8787), {
    dataDir: "/tmp/reach-data", publicOrigin: "https://gateway.example.com", setupToken: "setup-token",
    trustedProxies: ["192.0.2.1", "198.51.100.0/24"], retentionDays: 90,
  });
  assert.equal(parseConsoleConfig({ REACH_DATA_DIR: "/tmp/reach-data" }, "::1", 8787)?.publicOrigin, "http://[::1]:8787");
  assert.throws(() => parseConsoleConfig({ REACH_DATA_DIR: "/tmp/reach-data" }, "0.0.0.0", 8787), /REACH_PUBLIC_ORIGIN/);
  for (const value of ["0", "366", "1.5", "NaN", "1e2", ""]) {
    assert.throws(() => parseConsoleConfig({ REACH_AUDIT_RETENTION_DAYS: value }, "127.0.0.1", 8787), /1 and 365/);
  }
  for (const value of ["https://gateway.example.com/", "https://user:secret@gateway.example.com", "file:///tmp"]) {
    assert.throws(() => parseConsoleConfig({ REACH_DATA_DIR: "/tmp/reach-data", REACH_PUBLIC_ORIGIN: value }, "127.0.0.1", 8787));
  }
});

test("main fails before listening for invalid retention, origin and unwritable data", () => {
  const directory = mkdtempSync(join(tmpdir(), "reach-console-config-"));
  const file = join(directory, "file");
  writeFileSync(file, "not a directory");
  try {
    const env = { ...process.env, GATEWAY_HOST: "127.0.0.1", REACH_CONTROLLER_TOKEN: "c".repeat(48), REACH_ENGINE_TOKEN: "e".repeat(48), REACH_ENGINE_ID: "engine-a" };
    for (const [overrides, message] of [
      [{ REACH_DATA_DIR: file }, file],
      [{ REACH_DATA_DIR: directory, GATEWAY_HOST: "0.0.0.0" }, "REACH_PUBLIC_ORIGIN"],
      [{ REACH_AUDIT_RETENTION_DAYS: "366" }, "1 and 365"],
    ] as const) {
      const childEnv: NodeJS.ProcessEnv = { ...env, ...overrides };
      delete childEnv.REACH_PUBLIC_ORIGIN;
      const child = spawnSync(process.execPath, [new URL("../gateway-main.js", import.meta.url).pathname], { env: childEnv, encoding: "utf8", timeout: 5000 });
      assert.notEqual(child.status, 0);
      assert.ok(child.stderr.includes(message), child.stderr);
      assert.ok(!child.stdout.includes("listening"));
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("without a data directory the console and its administrator API return 404", async () => {
  const gateway = createGateway({ logger: () => {} });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  try {
    const address = gateway.address();
    assert.ok(address && typeof address === "object");
    for (const path of ["/console/", "/api/console/me"]) {
      assert.equal((await fetch(`http://127.0.0.1:${address.port}${path}`)).status, 404);
    }
  } finally { await new Promise<void>(resolve => gateway.close(() => resolve())); }
});
