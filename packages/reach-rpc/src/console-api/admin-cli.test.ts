import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hashPassword, newTotpSecret, verifyPassword } from "./credentials.js";
import { ConsoleStore } from "./store.js";
import { UserStore } from "./users.js";

const entry = new URL("../gateway-main.js", import.meta.url).pathname;
const run = (args: string[], input: string, env: Record<string, string>) =>
  spawnSync(process.execPath, [entry, "admin", ...args], { input, encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } });

test("admin reset-password restores a locked-out account without printing secrets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reach-admin-cli-"));
  try {
    let store = new ConsoleStore(directory);
    const users = new UserStore(store);
    const admin = users.create("admin", await hashPassword("the original password"), "admin");
    users.enableTotp(admin.id, newTotpSecret(), 1);
    store.db.prepare("INSERT INTO console_sessions (digest,user_id,csrf_token,created_at,last_seen_at,reauthenticated_at) VALUES ('s',?,?,1,1,1)").run(admin.id, "csrf");
    const before = new Map(store.db.prepare("SELECT username,password_hash FROM users").all().map(row => [row.username, row.password_hash]));
    store.close();

    const unknown = run(["reset-password", "nobody"], "a replacement password\n", { REACH_DATA_DIR: directory });
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /no console account named "nobody"/);
    const short = run(["reset-password", "admin"], "short\n", { REACH_DATA_DIR: directory });
    assert.notEqual(short.status, 0);
    assert.equal(run(["reset-password", "admin"], "", {}).status, 1, "REACH_DATA_DIR is required");
    store = new ConsoleStore(directory);
    assert.equal(store.db.prepare("SELECT password_hash FROM users WHERE username='admin'").get()!.password_hash, before.get("admin"), "failed runs change nothing");
    store.close();

    const reset = run(["reset-password", "ADMIN"], "a replacement password\n", { REACH_DATA_DIR: directory });
    assert.equal(reset.status, 0, reset.stderr);
    assert.ok(!`${reset.stdout}${reset.stderr}`.includes("a replacement password"));
    store = new ConsoleStore(directory);
    try {
      const row = store.db.prepare("SELECT * FROM users WHERE id=?").get(admin.id)!;
      assert.equal(await verifyPassword("a replacement password", String(row.password_hash)), true);
      assert.equal(row.totp_secret, null);
      assert.equal(row.disabled, 0);
      assert.equal(store.db.prepare("SELECT count(*) AS n FROM recovery_codes").get()!.n, 0);
      assert.equal(store.db.prepare("SELECT count(*) AS n FROM console_sessions").get()!.n, 0);
      assert.equal(store.db.prepare("SELECT client_label FROM activity WHERE event_type='admin.action'").get()!.client_label, "Host CLI");
    } finally { store.close(); }
    const help = run(["--help"], "", {});
    assert.equal(help.status, 0);
    assert.match(help.stderr, /gateway-main\.js admin reset-password <username>/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("admin reset-password records the action and rolls the reset back when the audit write fails", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reach-admin-cli-audit-"));
  try {
    let store = new ConsoleStore(directory);
    const users = new UserStore(store);
    const admin = users.create("admin", await hashPassword("the original password"), "admin");
    const original = String(store.db.prepare("SELECT password_hash FROM users WHERE id=?").get(admin.id)!.password_hash);
    store.db.exec("ALTER TABLE activity RENAME TO activity_unavailable");
    store.close();
    const failed = run(["reset-password", "admin"], "a replacement password\n", { REACH_DATA_DIR: directory });
    assert.notEqual(failed.status, 0);
    store = new ConsoleStore(directory);
    assert.equal(store.db.prepare("SELECT password_hash FROM users WHERE id=?").get(admin.id)!.password_hash, original, "the reset rolled back with the audit");
    store.db.exec("ALTER TABLE activity_unavailable RENAME TO activity");
    store.close();
    assert.equal(run(["reset-password", "admin"], "a replacement password\n", { REACH_DATA_DIR: directory }).status, 0);
    store = new ConsoleStore(directory);
    try {
      assert.equal(store.db.prepare("SELECT method FROM activity WHERE event_type='admin.action'").get()!.method, "user.password.reset:admin");
    } finally { store.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
