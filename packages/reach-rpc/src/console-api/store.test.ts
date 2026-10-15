import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConsoleStore } from "./store.js";

test("console storage migrates once, persists data and restricts database permissions", () => {
  const directory = mkdtempSync(join(tmpdir(), "reach-console-store-"));
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const store = new ConsoleStore(directory);
      try {
        assert.equal(statSync(store.path).mode & 0o777, 0o600);
        assert.equal(store.db.prepare("PRAGMA journal_mode").get()!.journal_mode, "wal");
        assert.equal(store.db.prepare("PRAGMA user_version").get()!.user_version, 2);
        const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name != 'sqlite_sequence' ORDER BY name").all();
        assert.deepEqual(tables.map(row => row.name), ["activity", "admin", "clients", "console_sessions", "engines", "oauth_clients", "oauth_tokens", "recovery_codes", "settings"]);
        const indexes = store.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='activity'").all();
        assert.deepEqual(indexes.map(row => row.name).sort(), ["activity_client_ts", "activity_engine_ts", "activity_ts"]);
        if (attempt === 0) store.db.prepare("INSERT INTO settings VALUES (?, ?)").run("theme", "light");
        assert.equal(store.db.prepare("SELECT value FROM settings WHERE key='theme'").get()!.value, "light");
      } finally { store.close(); }
    }
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
