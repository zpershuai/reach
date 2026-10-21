import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ConsoleStore } from "./store.js";

test("console storage migrates once, persists data and restricts database permissions", () => {
  const directory = mkdtempSync(join(tmpdir(), "reach-console-store-"));
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const store = new ConsoleStore(directory);
      try {
        assert.equal(statSync(store.path).mode & 0o777, 0o600);
        assert.equal(store.db.prepare("PRAGMA journal_mode").get()!.journal_mode, "wal");
        assert.equal(store.db.prepare("PRAGMA user_version").get()!.user_version, 4);
        const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name != 'sqlite_sequence' ORDER BY name").all();
        assert.deepEqual(tables.map(row => row.name), ["activity", "admin", "client_credentials", "client_permissions", "client_principals", "clients", "console_sessions", "engines", "oauth_clients", "oauth_tokens", "recovery_codes", "settings"]);
        const indexes = store.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='activity'").all();
        assert.deepEqual(indexes.map(row => row.name).sort(), ["activity_client_ts", "activity_engine_ts", "activity_ts"]);
        if (attempt === 0) store.db.prepare("INSERT INTO settings VALUES (?, ?)").run("theme", "light");
        assert.equal(store.db.prepare("SELECT value FROM settings WHERE key='theme'").get()!.value, "light");
      } finally { store.close(); }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function legacyStore(directory: string): DatabaseSync {
  const store = new ConsoleStore(directory);
  store.db.exec("DROP TABLE client_credentials; DROP TABLE client_permissions; DROP TABLE client_principals; ALTER TABLE activity DROP COLUMN principal_id; PRAGMA user_version=2;");
  store.close();
  return new DatabaseSync(join(directory, "reach.db"));
}

test("legacy migration preserves credentials and marks only approved OAuth authority for review", () => {
  const directory = mkdtempSync(join(tmpdir(), "reach-access-migration-"));
  try {
    const legacy = legacyStore(directory);
    legacy.prepare("INSERT INTO engines (id,display_name,token_digest,origin,created_at) VALUES (?,?,?,?,?)").run("engine-a", "Fixture", "engine-digest", "seed", 1);
    const insert = legacy.prepare("INSERT INTO oauth_clients (id,name,redirect_uris,auth_method,created_at,approved_at) VALUES (?,?,?,?,?,?)");
    insert.run("approved", "Approved fixture", "[]", "none", 1, 2);
    insert.run("pending", "Pending fixture", "[]", "none", 1, null);
    legacy.prepare("INSERT INTO oauth_tokens (digest,kind,client_id,family,expires_at) VALUES (?,?,?,?,?)").run("oauth-digest", "access", "approved", "fixture-family", 10000);
    legacy.close();
    for (let attempt = 0; attempt < 2; attempt++) {
      const store = new ConsoleStore(directory);
      try {
        const rows = store.db.prepare("SELECT id,kind,oauth_client_id,legacy_global,review_required,policy_revision FROM client_principals").all();
        assert.deepEqual(rows.map(row => ({ ...row })), [{ id: "oauth:approved", kind: "oauth", oauth_client_id: "approved", legacy_global: 1, review_required: 1, policy_revision: 1 }]);
        assert.equal(store.db.prepare("SELECT token_digest FROM engines WHERE id='engine-a'").get()!.token_digest, "engine-digest");
        assert.equal(store.db.prepare("SELECT digest FROM oauth_tokens").get()!.digest, "oauth-digest");
        assert.equal(store.db.prepare("SELECT count(*) AS n FROM client_credentials").get()!.n, 0);
      } finally { store.close(); }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("failed access migration rolls back DDL and version without damaging old data", () => {
  const directory = mkdtempSync(join(tmpdir(), "reach-access-migration-"));
  try {
    const legacy = legacyStore(directory);
    legacy.exec("CREATE TABLE client_permissions (conflict TEXT); INSERT INTO settings VALUES ('fixture','retained');");
    legacy.close();
    assert.throws(() => new ConsoleStore(directory), /already exists/);
    const database = new DatabaseSync(join(directory, "reach.db"));
    try {
      assert.equal(database.prepare("PRAGMA user_version").get()!.user_version, 2);
      assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name='client_principals'").get(), undefined);
      assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name='client_credentials'").get(), undefined);
      assert.equal(database.prepare("SELECT value FROM settings WHERE key='fixture'").get()!.value, "retained");
    } finally { database.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("console storage rolls back a failed transaction", () => {
  const directory = mkdtempSync(join(tmpdir(), "reach-console-store-"));
  const store = new ConsoleStore(directory);
  try {
    assert.throws(() => store.transaction(() => {
      store.db.prepare("INSERT INTO settings VALUES (?, ?)").run("theme", "dark");
      throw new Error("aborted");
    }), /aborted/);
    assert.equal(store.db.prepare("SELECT * FROM settings").all().length, 0);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
