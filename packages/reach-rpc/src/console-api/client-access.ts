import { randomBytes, randomUUID } from "node:crypto";
import { parseClientPermissions, type ClientPermission } from "../client-policy.js";
import { credentialDigest } from "./credentials.js";
import type { ConsoleStore } from "./store.js";

export class ClientAccessError extends Error {
  constructor(readonly status: number, message: string, readonly code: string) { super(message); }
}

export interface AccessClient {
  id: string;
  kind: "delegated" | "oauth";
  name: string;
  createdAt: number;
  revokedAt: number | null;
  expiresAt: number | null;
  policyRevision: number;
  legacyGlobal: boolean;
  reviewRequired: boolean;
  permissions: ClientPermission[];
}

export interface DelegatedIdentity {
  principalId: string;
  credentialDigest: string;
  expiresAt: number;
}

export interface AccessChange {
  principalId: string;
  reason: "policy" | "rotation" | "revocation" | "expiry";
}

/** Persistent identities and current policy; display labels never authenticate calls. */
export class ClientAccess {
  private readonly listeners = new Set<(change: AccessChange) => void>();
  /**
   * Policies are read on every authorized call. Writes through this instance clear the cache before
   * they run; commits from any other connection change SQLite's data_version, which also clears it.
   */
  private readonly cache = new Map<string, AccessClient>();
  private cachedVersion: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(private readonly store: ConsoleStore, private readonly now = Date.now, private readonly logger: (message: string) => void = console.error) {
    this.scheduleExpiry();
  }

  private validateExpiry(expiresAt: number): void {
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now() || expiresAt > 8_640_000_000_000_000) throw new ClientAccessError(400, "Credential expiry must be a future timestamp", "INVALID_CREDENTIAL_EXPIRY");
  }

  private validateName(name: string): string {
    if (typeof name !== "string" || !name.trim() || name.trim().length > 64 || /[\x00-\x1f\x7f]/.test(name)) throw new ClientAccessError(400, "Client name must contain 1–64 printable characters", "INVALID_CLIENT_NAME");
    return name.trim();
  }

  private changed(principalId: string, reason: AccessChange["reason"]): void {
    for (const listener of this.listeners) {
      try { listener({ principalId, reason }); }
      catch { try { this.logger("Client authority cleanup requires retry"); } catch { /* Authority is already invalidated in storage. */ } }
    }
    this.scheduleExpiry();
  }

  /** For writes made through foreign keys elsewhere, such as deleting an OAuth client row. */
  invalidate(): void {
    this.cache.clear();
  }

  private write(sql: string) {
    this.cache.clear();
    return this.store.db.prepare(sql);
  }

  subscribe(listener: (change: AccessChange) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private writePermissions(principalId: string, permissions: readonly ClientPermission[]): void {
    this.write("DELETE FROM client_permissions WHERE principal_id=?").run(principalId);
    const insert = this.write("INSERT INTO client_permissions (principal_id,engine_id,workspace,can_read,can_write,can_execute) VALUES (?,?,?,?,?,?)");
    for (const permission of permissions) insert.run(principalId, permission.engineId, permission.workspace, Number(permission.read), Number(permission.write), Number(permission.execute));
  }

  private issueCredential(principalId: string, expiresAt: number): string {
    const token = `reach_ct_${randomBytes(32).toString("base64url")}`;
    this.write(`INSERT INTO client_credentials (digest,principal_id,created_at,expires_at,revoked_at) VALUES (?,?,?,?,NULL)
      ON CONFLICT(principal_id) DO UPDATE SET digest=excluded.digest,created_at=excluded.created_at,expires_at=excluded.expires_at,revoked_at=NULL`)
      .run(credentialDigest(token), principalId, this.now(), expiresAt);
    return token;
  }

  create(name: string, expiresAt: number, value: unknown = []): { client: AccessClient; token: string } {
    const displayName = this.validateName(name);
    this.validateExpiry(expiresAt);
    const permissions = parseClientPermissions(value);
    const id = `client:${randomUUID()}`;
    const token = this.store.transaction(() => {
      this.write("INSERT INTO client_principals (id,kind,display_name,created_at) VALUES (?,'delegated',?,?)").run(id, displayName, this.now());
      this.writePermissions(id, permissions);
      return this.issueCredential(id, expiresAt);
    });
    this.scheduleExpiry();
    return { client: this.get(id), token };
  }

  approveOAuth(clientId: string, name: string, value: unknown): AccessClient {
    const permissions = parseClientPermissions(value);
    if (!permissions.length) throw new ClientAccessError(400, "Select resources and permissions", "CLIENT_PERMISSIONS_REQUIRED");
    const id = `oauth:${clientId}`;
    this.store.transaction(() => {
      this.write(`INSERT INTO client_principals (id,kind,oauth_client_id,display_name,created_at) VALUES (?,'oauth',?,?,?)
        ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,revoked_at=NULL,policy_revision=policy_revision+1,legacy_global=0,review_required=0`)
        .run(id, clientId, this.validateName(name), this.now());
      this.writePermissions(id, permissions);
    });
    this.changed(id, "policy");
    return this.get(id);
  }

  invalidateOAuth(clientId: string): void {
    const id = `oauth:${clientId}`;
    this.write("UPDATE client_principals SET policy_revision=policy_revision+1 WHERE id=?").run(id);
    this.changed(id, "revocation");
  }

  get(id: string): AccessClient {
    const version = Number(this.store.db.prepare("PRAGMA data_version").get()!.data_version);
    if (version !== this.cachedVersion) { this.cache.clear(); this.cachedVersion = version; }
    const cached = this.cache.get(id);
    if (cached) return cached;
    const client = this.read(id);
    this.cache.set(id, client);
    return client;
  }

  private read(id: string): AccessClient {
    const row = this.store.db.prepare(`SELECT p.*,c.expires_at FROM client_principals p
      LEFT JOIN client_credentials c ON c.principal_id=p.id WHERE p.id=?`).get(id);
    if (!row) throw new ClientAccessError(404, "Unknown client identity", "CLIENT_IDENTITY_NOT_FOUND");
    const permissions = this.store.db.prepare("SELECT * FROM client_permissions WHERE principal_id=? ORDER BY engine_id,workspace").all(id).map(permission => ({
      engineId: String(permission.engine_id), workspace: String(permission.workspace), read: Boolean(permission.can_read), write: Boolean(permission.can_write), execute: Boolean(permission.can_execute),
    }));
    return Object.freeze({ id: String(row.id), kind: row.kind as AccessClient["kind"], name: String(row.display_name), createdAt: Number(row.created_at),
      revokedAt: row.revoked_at === null ? null : Number(row.revoked_at), expiresAt: row.expires_at === null ? null : Number(row.expires_at),
      policyRevision: Number(row.policy_revision), legacyGlobal: Boolean(row.legacy_global), reviewRequired: Boolean(row.review_required),
      permissions: Object.freeze(permissions.map(permission => Object.freeze(permission))) as ClientPermission[] }) as AccessClient;
  }

  list(): AccessClient[] {
    return this.store.db.prepare("SELECT id FROM client_principals ORDER BY created_at,id").all().map(row => this.get(String(row.id)));
  }

  authenticate(authorization: string | undefined): DelegatedIdentity | undefined {
    if (!authorization?.startsWith("Bearer ")) return undefined;
    const token = authorization.slice(7);
    if (!/^reach_ct_[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const digest = credentialDigest(token);
    const row = this.store.db.prepare(`SELECT p.id,c.expires_at FROM client_credentials c JOIN client_principals p ON p.id=c.principal_id
      WHERE c.digest=? AND p.revoked_at IS NULL AND c.revoked_at IS NULL AND c.expires_at > ?`).get(digest, this.now());
    return row ? { principalId: String(row.id), credentialDigest: digest, expiresAt: Number(row.expires_at) } : undefined;
  }

  requireDelegated(authorization: string | undefined): DelegatedIdentity {
    const identity = this.authenticate(authorization);
    if (!identity) throw new ClientAccessError(401, "Invalid or expired client credential", "INVALID_CLIENT_CREDENTIAL");
    return identity;
  }

  valid(identity: DelegatedIdentity): boolean {
    const row = this.store.db.prepare(`SELECT p.id FROM client_credentials c JOIN client_principals p ON p.id=c.principal_id
      WHERE p.id=? AND c.digest=? AND p.revoked_at IS NULL AND c.revoked_at IS NULL AND c.expires_at > ?`).get(identity.principalId, identity.credentialDigest, this.now());
    return Boolean(row);
  }

  rotate(id: string, expiresAt: number): { client: AccessClient; token: string } {
    const client = this.get(id);
    if (client.kind !== "delegated" || client.revokedAt !== null) throw new ClientAccessError(409, "Only active delegated identities can rotate credentials", "CLIENT_ROTATION_NOT_ALLOWED");
    this.validateExpiry(expiresAt);
    const token = this.store.transaction(() => {
      this.write("UPDATE client_principals SET policy_revision=policy_revision+1 WHERE id=?").run(id);
      return this.issueCredential(id, expiresAt);
    });
    this.changed(id, "rotation");
    return { client: this.get(id), token };
  }

  setPolicy(id: string, value: unknown): AccessClient {
    this.get(id);
    const permissions = parseClientPermissions(value);
    this.store.transaction(() => {
      this.writePermissions(id, permissions);
      this.write("UPDATE client_principals SET policy_revision=policy_revision+1,legacy_global=0,review_required=0 WHERE id=?").run(id);
    });
    this.changed(id, "policy");
    return this.get(id);
  }

  reviewLegacy(id: string): AccessClient {
    const client = this.get(id);
    if (!client.legacyGlobal || client.kind !== "oauth") throw new ClientAccessError(409, "Only existing legacy OAuth authority can be reviewed as global", "CLIENT_GLOBAL_REVIEW_NOT_ALLOWED");
    this.write("UPDATE client_principals SET review_required=0 WHERE id=?").run(id);
    return this.get(id);
  }

  revoke(id: string): void {
    const client = this.get(id);
    if (client.revokedAt !== null) return;
    this.store.transaction(() => {
      this.write("UPDATE client_principals SET revoked_at=?,policy_revision=policy_revision+1 WHERE id=?").run(this.now(), id);
      this.write("UPDATE client_credentials SET revoked_at=? WHERE principal_id=?").run(this.now(), id);
      if (client.kind === "oauth") this.write("DELETE FROM oauth_tokens WHERE client_id=(SELECT oauth_client_id FROM client_principals WHERE id=?)").run(id);
    });
    this.changed(id, "revocation");
  }

  expire(): void {
    const ids = this.store.db.prepare("SELECT principal_id FROM client_credentials WHERE revoked_at IS NULL AND expires_at<=?").all(this.now());
    this.store.transaction(() => {
      this.write("UPDATE client_credentials SET revoked_at=? WHERE revoked_at IS NULL AND expires_at<=?").run(this.now(), this.now());
      for (const row of ids) this.write("UPDATE client_principals SET policy_revision=policy_revision+1 WHERE id=?").run(row.principal_id);
    });
    for (const row of ids) this.changed(String(row.principal_id), "expiry");
    this.scheduleExpiry();
  }

  private scheduleExpiry(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed) return;
    const row = this.store.db.prepare("SELECT min(expires_at) AS next FROM client_credentials WHERE revoked_at IS NULL").get()!;
    if (row.next === null) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try { this.expire(); }
      catch {
        try { this.logger("Client credential expiry cleanup requires retry"); } catch { /* Authentication still checks expiry on every request. */ }
        if (!this.closed) { this.timer = setTimeout(() => this.scheduleExpiry(), 1000); this.timer.unref(); }
      }
    }, Math.max(1, Math.min(2_147_483_647, Number(row.next) - this.now())));
    this.timer.unref();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.listeners.clear();
  }
}
