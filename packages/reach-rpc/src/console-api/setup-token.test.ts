import assert from "node:assert/strict";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadSetupToken, removeSetupToken } from "./setup-token.js";
import { ConsoleStore } from "./store.js";
import { ConsoleAuth } from "./auth.js";
import { GatewayEvents } from "./events.js";

test("bootstrap file survives restart, refuses unsafe entries and never overwrites them", () => {
  const directory = mkdtempSync(join(tmpdir(), "reach-setup-file-"));
  const path = join(directory, "admin-setup-token");
  const target = join(directory, "private-fixture");
  try {
    const token = loadSetupToken(directory);
    assert.match(token, /^[a-f0-9]{48}$/); assert.equal(loadSetupToken(directory), token);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    chmodSync(path, 0o644);
    assert.throws(() => loadSetupToken(directory), /safely/); assert.equal(removeSetupToken(directory), false);
    assert.equal(readFileSync(path, "utf8"), token + "\n");
    rmSync(path); writeFileSync(target, "retain fixture"); symlinkSync(target, path);
    assert.throws(() => loadSetupToken(directory), /safely/); assert.equal(removeSetupToken(directory), false);
    assert.equal(readFileSync(target, "utf8"), "retain fixture");
    rmSync(path); mkdirSync(path);
    assert.throws(() => loadSetupToken(directory), /safely/); rmSync(path, { recursive: true });
    writeFileSync(path, "malformed fixture", { mode: 0o600 }); assert.throws(() => loadSetupToken(directory), /safely/); rmSync(path);
    chmodSync(directory, 0o777); assert.throws(() => loadSetupToken(directory), /Unsafe/);
    // Group-writable (Kubernetes fsGroup) and sticky world-writable directories are usable.
    for (const mode of [0o770, 0o2775, 0o1777]) {
      chmodSync(directory, mode); const token = loadSetupToken(directory);
      assert.equal(loadSetupToken(directory), token); assert.equal(removeSetupToken(directory), true);
    }
  } finally { chmodSync(directory, 0o700); rmSync(directory, { recursive: true, force: true }); }
});

test("concurrent bootstrap creation publishes only a complete credential and no stdout or stderr secret", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reach-setup-concurrent-"));
  const module = new URL("./setup-token.js", import.meta.url).href;
  try {
    const results = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      // One writer outlives its direct parent so exit cannot imply drained stdio.
      const emit = index === 0
        ? `const { spawn } = await import('node:child_process'); const writer = spawn(process.execPath, ['-e', 'setTimeout(() => process.stdout.write(process.argv[1]), 25)', digest], { stdio: ['ignore', 1, 2] }); writer.unref();`
        : `process.stdout.write(digest);`;
      const program = `import { loadSetupToken } from ${JSON.stringify(module)}; import { createHash } from 'node:crypto'; const token = loadSetupToken(process.argv[1]); const digest = createHash('sha256').update(token).digest('hex'); ${emit}`;
      const child = spawn(process.execPath, ["--input-type=module", "-e", program, directory], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
      const [code] = await once(child, "close"); assert.equal(code, 0, stderr); return { stdout, stderr };
    }));
    const token = readFileSync(join(directory, "admin-setup-token"), "utf8").trim();
    const expected = createHash("sha256").update(token).digest("hex");
    assert.equal(new Set(results.map(result => result.stdout)).size, 1);
    assert.ok(results.every(result => /^[a-f0-9]{64}$/.test(result.stdout) && result.stdout === expected));
    assert.ok(results.every(result => !result.stdout.includes(token) && !result.stderr.includes(token)));
    assert.deepEqual(readdirSync(directory), ["admin-setup-token"]);
    removeSetupToken(directory); assert.equal(existsSync(join(directory, "admin-setup-token")), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("auth reuses generated bootstrap on restart, preserves env delivery and existing administrator", () => {
  const directory = mkdtempSync(join(tmpdir(), "reach-setup-restart-"));
  const path = join(directory, "admin-setup-token");
  const logs: string[] = [];
  const config = { dataDir: directory, publicOrigin: "https://gateway.example.com", trustedProxies: [], retentionDays: 30 };
  try {
    for (let run = 0; run < 2; run++) {
      const store = new ConsoleStore(directory);
      try { new ConsoleAuth(store, config, new GatewayEvents(), Date.now, message => logs.push(message)); }
      finally { store.close(); }
    }
    const token = loadSetupToken(directory); assert.ok(!logs.join("\n").includes(token));
    removeSetupToken(directory);
    const store = new ConsoleStore(directory);
    try {
      new ConsoleAuth(store, { ...config, setupToken: "explicit-private-fixture-token" }, new GatewayEvents(), Date.now, message => logs.push(message));
      assert.equal(existsSync(path), false); assert.ok(!logs.join("\n").includes("explicit-private-fixture-token"));
      loadSetupToken(directory);
      store.db.prepare("INSERT INTO admin (id,password_hash,totp_secret,created_at) VALUES (1,?,?,?)").run("fixture-hash", "fixture-secret", Date.now());
      new ConsoleAuth(store, config, new GatewayEvents(), Date.now, message => logs.push(message));
      assert.equal(existsSync(path), false); assert.equal(store.db.prepare("SELECT password_hash FROM admin").get()!.password_hash, "fixture-hash");
      // A leftover file that cannot be removed safely must not stop an already configured Gateway.
      writeFileSync(path, "leftover fixture", { mode: 0o644 });
      new ConsoleAuth(store, config, new GatewayEvents(), Date.now, message => logs.push(message));
      assert.ok(logs.some(message => message.startsWith("CONSOLE_SETUP_TOKEN_NOT_REMOVED")));
      assert.equal(readFileSync(path, "utf8"), "leftover fixture");
    } finally { store.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a Gateway process delivers setup only through its private file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reach-setup-output-"));
  const module = new URL("../gateway.js", import.meta.url).href;
  const program = `import { createGateway } from ${JSON.stringify(module)}; const server = createGateway({console:{dataDir:process.argv[1],publicOrigin:'https://gateway.example.com',trustedProxies:[],retentionDays:30}}); server.listen(0,'127.0.0.1',()=>console.log('FIXTURE_READY'));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", program, directory], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Gateway fixture did not start")), 5000);
      child.once("exit", () => { clearTimeout(timeout); reject(new Error("Gateway fixture exited")); });
      child.stdout.on("data", () => { if (stdout.includes("FIXTURE_READY")) { clearTimeout(timeout); resolve(); } });
    });
    const token = readFileSync(join(directory, "admin-setup-token"), "utf8").trim();
    assert.ok(stdout.includes("read REACH_DATA_DIR/admin-setup-token privately"));
    assert.ok(!stdout.includes(token) && !stderr.includes(token));
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill("SIGTERM"); await exit; }
    rmSync(directory, { recursive: true, force: true });
  }
});
