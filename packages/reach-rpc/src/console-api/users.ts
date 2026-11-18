import { AccountCredentials, usernameKey, type UserRole } from "./credentials.js";
import type { ConsoleStore } from "./store.js";

/** What the console may see about an account: never hashes, secrets or recovery codes. */
export interface ConsoleUser {
  id: number;
  username: string;
  role: UserRole;
  totpEnabled: boolean;
  disabled: boolean;
  createdAt: number;
  lastLoginAt: number | null;
}

export class UserStoreError extends Error {
  constructor(readonly status: number, message: string, readonly code: string) { super(message); }
}

type Row = Record<string, unknown>;

function view(row: Row): ConsoleUser {
  return {
    id: Number(row.id), username: String(row.username), role: row.role === "admin" ? "admin" : "user",
    totpEnabled: row.totp_secret !== null, disabled: Number(row.disabled) === 1,
    createdAt: Number(row.created_at), lastLoginAt: row.last_login_at === null ? null : Number(row.last_login_at),
  };
}

/** Console account storage. Every write that removes authority also revokes the affected sessions. */
export class UserStore {
  readonly credentials: AccountCredentials;
  constructor(private readonly store: ConsoleStore, private readonly now = Date.now) {
    this.credentials = new AccountCredentials(store);
  }

  any(): boolean { return Boolean(this.store.db.prepare("SELECT id FROM users LIMIT 1").get()); }

  list(): ConsoleUser[] { return this.store.db.prepare("SELECT * FROM users ORDER BY id").all().map(view); }

  get(id: number): ConsoleUser | undefined {
    const row = this.store.db.prepare("SELECT * FROM users WHERE id=?").get(id);
    return row ? view(row) : undefined;
  }

  /** Returns the account with its password hash for credential checks only. */
  credentialsFor(username: string): (ConsoleUser & { passwordHash: string }) | undefined {
    const row = this.store.db.prepare("SELECT * FROM users WHERE username_key=?").get(usernameKey(username));
    return row ? { ...view(row), passwordHash: String(row.password_hash) } : undefined;
  }

  passwordHash(id: number): string | undefined {
    const row = this.store.db.prepare("SELECT password_hash FROM users WHERE id=?").get(id);
    return row ? String(row.password_hash) : undefined;
  }

  create(username: string, passwordHash: string, role: UserRole): ConsoleUser {
    return this.store.transaction(() => {
      if (this.store.db.prepare("SELECT id FROM users WHERE username_key=?").get(usernameKey(username))) {
        throw new UserStoreError(409, "Username already exists", "USERNAME_TAKEN");
      }
      const now = this.now();
      const result = this.store.db.prepare(`INSERT INTO users (username, username_key, password_hash, role, created_at, password_changed_at)
        VALUES (?,?,?,?,?,?)`).run(username, usernameKey(username), passwordHash, role, now, now);
      return this.get(Number(result.lastInsertRowid))!;
    });
  }

  private require(id: number): ConsoleUser {
    const user = this.get(id);
    if (!user) throw new UserStoreError(404, "Unknown user", "USER_NOT_FOUND");
    return user;
  }

  /** Throws LAST_ADMIN when the change would leave no enabled admin. Call inside the write's transaction. */
  private keepAnAdmin(id: number): void {
    const others = this.store.db.prepare("SELECT count(*) AS n FROM users WHERE role='admin' AND disabled=0 AND id != ?").get(id)!;
    if (Number(others.n) === 0) throw new UserStoreError(409, "At least one enabled administrator is required", "LAST_ADMIN");
  }

  update(id: number, patch: { role?: UserRole; disabled?: boolean }): ConsoleUser {
    return this.store.transaction(() => {
      const user = this.require(id);
      const losesAdmin = user.role === "admin" && !user.disabled && (patch.role === "user" || patch.disabled === true);
      if (losesAdmin) this.keepAnAdmin(id);
      if (patch.role !== undefined) this.store.db.prepare("UPDATE users SET role=? WHERE id=?").run(patch.role, id);
      if (patch.disabled !== undefined) {
        this.store.db.prepare("UPDATE users SET disabled=? WHERE id=?").run(patch.disabled ? 1 : 0, id);
        if (patch.disabled) this.revokeSessions(id);
      }
      return this.get(id)!;
    });
  }

  /**
   * Sets a password. `keepSession` keeps that session (self-service); otherwise every session is revoked.
   * `reset` also enables the account and clears TOTP, as the offline recovery does.
   */
  setPassword(id: number, passwordHash: string, options: { keepSession?: string; reset?: boolean; alsoRecord?: (user: ConsoleUser) => void } = {}): ConsoleUser {
    return this.store.transaction(() => {
      const user = this.require(id);
      // Runs inside the same transaction, so a failed audit write rolls the change back.
      options.alsoRecord?.(user);
      this.store.db.prepare("UPDATE users SET password_hash=?, password_changed_at=? WHERE id=?").run(passwordHash, this.now(), id);
      if (options.reset) {
        this.store.db.prepare("UPDATE users SET disabled=0, totp_secret=NULL, last_totp_step=-1 WHERE id=?").run(id);
        this.store.db.prepare("DELETE FROM recovery_codes WHERE user_id=?").run(id);
      }
      this.revokeSessions(id, options.keepSession);
      return this.get(id)!;
    });
  }

  /**
   * Enables TOTP at the confirmed step and returns fresh recovery codes. With `pendingSession`, the
   * session's pending secret must still be `secret` and is consumed in the same transaction, so two
   * concurrent confirmations cannot both enable it or overwrite each other's recovery codes.
   */
  enableTotp(id: number, secret: string, step: number, pendingSession?: string): string[] {
    return this.store.transaction(() => {
      this.require(id);
      if (pendingSession && this.store.db.prepare(`UPDATE console_sessions SET pending_totp_secret=NULL, pending_totp_expires_at=NULL
        WHERE digest=? AND user_id=? AND pending_totp_secret=? AND pending_totp_expires_at > ?`).run(pendingSession, id, secret, this.now()).changes !== 1) {
        throw new UserStoreError(409, "This authenticator enrolment is no longer pending; start again", "TOTP_ENROLMENT_STALE");
      }
      if (this.store.db.prepare("UPDATE users SET totp_secret=?, last_totp_step=? WHERE id=? AND totp_secret IS NULL").run(secret, step, id).changes !== 1) {
        throw new UserStoreError(409, "Authenticator already enabled", "TOTP_ALREADY_ENABLED");
      }
      return this.credentials.replaceRecoveryCodes(id);
    });
  }

  /** Removes TOTP and recovery codes. `keepSession` keeps the caller's session for self-service. */
  disableTotp(id: number, keepSession?: string): ConsoleUser {
    return this.store.transaction(() => {
      this.require(id);
      this.store.db.prepare("UPDATE users SET totp_secret=NULL, last_totp_step=-1 WHERE id=?").run(id);
      this.store.db.prepare("DELETE FROM recovery_codes WHERE user_id=?").run(id);
      this.revokeSessions(id, keepSession);
      return this.get(id)!;
    });
  }

  delete(id: number): ConsoleUser {
    return this.store.transaction(() => {
      const user = this.require(id);
      if (user.role === "admin" && !user.disabled) this.keepAnAdmin(id);
      this.store.db.prepare("DELETE FROM users WHERE id=?").run(id);
      return user;
    });
  }

  recordLogin(id: number): void { this.store.db.prepare("UPDATE users SET last_login_at=? WHERE id=?").run(this.now(), id); }

  adminsWithoutTotp(): number {
    return Number(this.store.db.prepare("SELECT count(*) AS n FROM users WHERE role='admin' AND disabled=0 AND totp_secret IS NULL").get()!.n);
  }

  private revokeSessions(id: number, keep?: string): void {
    if (keep) this.store.db.prepare("DELETE FROM console_sessions WHERE user_id=? AND digest != ?").run(id, keep);
    else this.store.db.prepare("DELETE FROM console_sessions WHERE user_id=?").run(id);
  }
}
