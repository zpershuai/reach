import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ConfigurationError } from "../diagnostics.js";

const migrations = [
  `CREATE TABLE admin (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    password_hash TEXT NOT NULL,
    totp_secret TEXT NOT NULL,
    last_totp_step INTEGER NOT NULL DEFAULT -1,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE recovery_codes (
    digest TEXT PRIMARY KEY,
    admin_id INTEGER NOT NULL REFERENCES admin(id) ON DELETE CASCADE
  );
  CREATE TABLE console_sessions (
    digest TEXT PRIMARY KEY,
    admin_id INTEGER NOT NULL REFERENCES admin(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    reauthenticated_at INTEGER NOT NULL
  );
  CREATE TABLE engines (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    token_digest TEXT,
    origin TEXT NOT NULL CHECK (origin IN ('seed', 'console')),
    created_at INTEGER NOT NULL,
    device_override TEXT,
    hardware TEXT,
    last_seen_at INTEGER,
    engine_version TEXT
  );
  CREATE TABLE clients (
    label TEXT NOT NULL,
    type TEXT NOT NULL,
    last_seen_at INTEGER NOT NULL,
    PRIMARY KEY (label, type)
  );
  CREATE TABLE activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    request_id TEXT,
    engine_id TEXT,
    client_label TEXT,
    client_type TEXT,
    method TEXT,
    method_class TEXT,
    workspace TEXT,
    path TEXT,
    script TEXT,
    process_id TEXT,
    launch_id TEXT,
    outcome TEXT,
    code TEXT,
    stage TEXT,
    latency_ms REAL,
    response_bytes INTEGER
  );
  CREATE INDEX activity_ts ON activity(ts);
  CREATE INDEX activity_engine_ts ON activity(engine_id, ts);
  CREATE INDEX activity_client_ts ON activity(client_label, ts);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  `CREATE TABLE oauth_clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    auth_method TEXT NOT NULL CHECK (auth_method IN ('none', 'client_secret_post', 'client_secret_basic')),
    secret_digest TEXT,
    created_at INTEGER NOT NULL,
    approved_at INTEGER,
    last_used_at INTEGER
  );
  CREATE TABLE oauth_tokens (
    digest TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
    client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    family TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE INDEX oauth_tokens_family ON oauth_tokens(family);
  CREATE INDEX oauth_tokens_client ON oauth_tokens(client_id);`,
  `CREATE TABLE client_principals (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('delegated', 'oauth')),
    oauth_client_id TEXT UNIQUE REFERENCES oauth_clients(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER,
    policy_revision INTEGER NOT NULL DEFAULT 1 CHECK (policy_revision > 0),
    legacy_global INTEGER NOT NULL DEFAULT 0 CHECK (legacy_global IN (0, 1)),
    review_required INTEGER NOT NULL DEFAULT 0 CHECK (review_required IN (0, 1)),
    CHECK ((kind = 'oauth' AND oauth_client_id IS NOT NULL) OR (kind = 'delegated' AND oauth_client_id IS NULL))
  );
  CREATE TABLE client_credentials (
    digest TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL UNIQUE REFERENCES client_principals(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    CHECK (expires_at > created_at)
  );
  CREATE TABLE client_permissions (
    principal_id TEXT NOT NULL REFERENCES client_principals(id) ON DELETE CASCADE,
    engine_id TEXT NOT NULL,
    workspace TEXT NOT NULL,
    can_read INTEGER NOT NULL CHECK (can_read IN (0, 1)),
    can_write INTEGER NOT NULL CHECK (can_write IN (0, 1)),
    can_execute INTEGER NOT NULL CHECK (can_execute IN (0, 1)),
    PRIMARY KEY (principal_id, engine_id, workspace)
  );
  INSERT INTO client_principals (id, kind, oauth_client_id, display_name, created_at, legacy_global, review_required)
    SELECT 'oauth:' || id, 'oauth', id, name, created_at, 1, 1
    FROM oauth_clients WHERE approved_at IS NOT NULL;`,
  `ALTER TABLE activity ADD COLUMN principal_id TEXT;`,
];

/** Owns the database connection; callers close it after draining audit writes. */
export class ConsoleStore {
  readonly directory: string;
  readonly path: string;
  readonly db: DatabaseSync;

  constructor(directory: string) {
    this.directory = resolve(directory);
    this.path = join(this.directory, "reach.db");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    // Create with restrictive permissions before SQLite can write any secrets.
    closeSync(openSync(this.path, "a", 0o600));
    chmodSync(this.path, 0o600);
    this.db = new DatabaseSync(this.path);
    try {
      this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
      const version = Number(this.db.prepare("PRAGMA user_version").get()!.user_version);
      if (version > migrations.length) throw new ConfigurationError("Console database is newer than this Gateway; restore the matching backup or upgrade");
      for (let index = version; index < migrations.length; index++) {
        this.transaction(() => this.db.exec(`${migrations[index]} PRAGMA user_version=${index + 1};`));
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
