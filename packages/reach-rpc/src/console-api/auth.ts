import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BlockList, isIP } from "node:net";
import { credentialDigest, hashPassword, normalizeUsername, validPassword, verifyPassword, type UserRole } from "./credentials.js";
import type { ConsoleConfig } from "./config.js";
import type { GatewayEvents } from "./events.js";
import { PayloadTooLargeError, readJsonBody, sendJson } from "./http.js";
import type { ConsoleStore } from "./store.js";
import { loadSetupToken, removeSetupToken } from "./setup-token.js";
import { UserStore, UserStoreError, type ConsoleUser } from "./users.js";

const LEFTOVER_SETUP_TOKEN = "CONSOLE_SETUP_TOKEN_NOT_REMOVED: an account exists, so the leftover REACH_DATA_DIR/admin-setup-token is unusable; delete it manually";

const idleMs = 12 * 60 * 60 * 1000;
const absoluteMs = 7 * 24 * 60 * 60 * 1000;
export const recentMs = 10 * 60 * 1000;

export class ConsoleError extends Error {
  constructor(readonly status: number, message: string, readonly code: string, readonly retryAfter?: number) { super(message); }
}

export interface SessionUser { id: number; username: string; role: UserRole; totpEnabled: boolean }

export interface ConsoleSession {
  digest: string;
  csrfToken: string;
  createdAt: number;
  lastSeenAt: number;
  reauthenticatedAt: number;
  user: SessionUser;
  pendingTotpSecret?: string;
}

/** Audit caller for actions without a signed-in account. */
export type Actor = SessionUser | "Setup" | "Host CLI";

export type AccountCheck = { status: "ok"; user: ConsoleUser } | { status: "totp_required"; user: ConsoleUser } | { status: "fail" };

interface Bootstrap { csrfToken: string; expiresAt: number }

export function profile(user: SessionUser | ConsoleUser): SessionUser {
  return { id: user.id, username: user.username, role: user.role, totpEnabled: user.totpEnabled };
}

function cookie(request: IncomingMessage, name: string): string | undefined {
  return request.headers.cookie?.split(";").map(value => value.trim()).find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

function equal(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function address(value: string): string { return value.startsWith("::ffff:") && isIP(value.slice(7)) === 4 ? value.slice(7) : value; }

export class PeerResolver {
  private readonly trusted = new BlockList();
  constructor(proxies: string[]) {
    for (const proxy of proxies) {
      const [ip, prefix, extra] = proxy.split("/");
      const version = isIP(ip);
      const type = version === 4 ? "ipv4" : "ipv6";
      if (!version || extra !== undefined) throw new Error("Invalid REACH_TRUSTED_PROXIES address or CIDR");
      if (prefix === undefined) this.trusted.addAddress(ip, type);
      else {
        if (!/^\d+$/.test(prefix) || Number(prefix) > (version === 4 ? 32 : 128)) throw new Error("Invalid REACH_TRUSTED_PROXIES CIDR");
        this.trusted.addSubnet(ip, Number(prefix), type);
      }
    }
  }
  private isTrusted(ip: string): boolean {
    const version = isIP(ip);
    return version !== 0 && this.trusted.check(ip, version === 4 ? "ipv4" : "ipv6");
  }
  resolve(request: IncomingMessage): string {
    let peer = address(request.socket.remoteAddress ?? "unknown");
    if (!this.isTrusted(peer)) return peer;
    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded !== "string") return peer;
    const chain = forwarded.split(",").map(value => address(value.trim()));
    if (chain.some(value => !isIP(value))) return peer;
    for (const next of chain.reverse()) {
      if (!this.isTrusted(peer)) break;
      peer = next;
    }
    return peer;
  }
}

interface FailureBucket { count: number; expiresAt: number; until: number }
export class AuthRateLimiter {
  private readonly peers = new Map<string, FailureBucket>();
  private global: FailureBucket = { count: 0, expiresAt: 0, until: 0 };
  constructor(private readonly now = Date.now) {}
  check(peer: string): void {
    const until = Math.max(this.peers.get(peer)?.until ?? 0, this.global.until);
    if (until > this.now()) throw new ConsoleError(429, "Too many attempts; try again later", "RATE_LIMITED", Math.ceil((until - this.now()) / 1000));
  }
  failed(peer: string): void {
    const now = this.now();
    if (this.peers.size >= 10_000 && !this.peers.has(peer)) this.peers.delete(this.peers.keys().next().value!);
    const bump = (bucket: FailureBucket | undefined, threshold: number): FailureBucket => {
      const next = bucket && bucket.expiresAt > now ? bucket : { count: 0, expiresAt: now + 15 * 60_000, until: 0 };
      next.count++;
      if (next.count >= threshold) next.until = now + Math.min(15 * 60_000, 30_000 * 2 ** Math.min(10, next.count - threshold));
      return next;
    };
    this.peers.set(peer, bump(this.peers.get(peer), 5));
    this.global = bump(this.global, 100);
  }
}

export class ConsoleAuth {
  private setupDigest: string | undefined;
  private readonly bootstraps = new Map<string, Bootstrap>();
  readonly users: UserStore;
  readonly peers: PeerResolver;
  private readonly limiter: AuthRateLimiter;
  /** Verified for unknown usernames so their timing matches a wrong password. */
  private readonly dummyHash = hashPassword(randomBytes(16).toString("hex"));

  constructor(
    private readonly store: ConsoleStore,
    private readonly config: ConsoleConfig,
    private readonly events: GatewayEvents,
    private readonly now = Date.now,
    private readonly logger: (message: string) => void = console.log,
  ) {
    this.users = new UserStore(store, now);
    this.peers = new PeerResolver(config.trustedProxies);
    this.limiter = new AuthRateLimiter(now);
    if (!this.users.any()) {
      const token = config.setupToken || loadSetupToken(store.directory);
      this.setupDigest = credentialDigest(token);
      if (!config.setupToken) logger("Reach console setup credential: read REACH_DATA_DIR/admin-setup-token privately");
    } else if (!removeSetupToken(store.directory)) logger(LEFTOVER_SETUP_TOKEN);
  }

  session(request: IncomingMessage): ConsoleSession | undefined {
    const id = cookie(request, "reach_console");
    if (!id || !/^[a-f0-9]{64}$/.test(id)) return undefined;
    const digest = credentialDigest(id);
    const row = this.store.db.prepare(`SELECT s.*, u.username, u.role, u.disabled, u.totp_secret IS NOT NULL AS totp_enabled
      FROM console_sessions s JOIN users u ON u.id = s.user_id WHERE s.digest=?`).get(digest);
    if (!row) return undefined;
    if (Number(row.disabled) === 1 || this.now() - Number(row.last_seen_at) >= idleMs || this.now() - Number(row.created_at) >= absoluteMs) {
      this.store.db.prepare("DELETE FROM console_sessions WHERE digest=?").run(digest);
      return undefined;
    }
    this.store.db.prepare("UPDATE console_sessions SET last_seen_at=? WHERE digest=?").run(this.now(), digest);
    const pending = row.pending_totp_secret !== null && Number(row.pending_totp_expires_at) > this.now() ? String(row.pending_totp_secret) : undefined;
    return {
      digest, csrfToken: String(row.csrf_token), createdAt: Number(row.created_at), lastSeenAt: this.now(), reauthenticatedAt: Number(row.reauthenticated_at),
      user: { id: Number(row.user_id), username: String(row.username), role: row.role === "admin" ? "admin" : "user", totpEnabled: Number(row.totp_enabled) === 1 },
      ...(pending ? { pendingTotpSecret: pending } : {}),
    };
  }

  /** Authenticates a console API request; `role: "admin"` rejects read-only accounts with ROLE_FORBIDDEN. */
  require(request: IncomingMessage, mutation = false, recent = false, role: "any" | "admin" = "any"): ConsoleSession {
    const session = this.session(request);
    if (!session) throw new ConsoleError(401, "Sign in required", "SIGN_IN_REQUIRED");
    if (mutation) this.checkCsrf(request, session.csrfToken);
    if (role === "admin" && session.user.role !== "admin") throw new ConsoleError(403, "Your account is read-only", "ROLE_FORBIDDEN");
    if (recent && this.now() - session.reauthenticatedAt >= recentMs) throw new ConsoleError(403, "Re-authentication required", "REAUTH_REQUIRED");
    return session;
  }

  private checkCsrf(request: IncomingMessage, expected: string): void {
    if (request.headers.origin !== this.config.publicOrigin || !equal(typeof request.headers["x-csrf-token"] === "string" ? request.headers["x-csrf-token"] : undefined, expected)) {
      throw new ConsoleError(403, "Origin or CSRF token rejected", "CSRF_REJECTED");
    }
  }

  private cookieValue(name: string, value: string, maxAge: number): string {
    return `${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${this.config.publicOrigin.startsWith("https:") ? "; Secure" : ""}`;
  }

  private bootstrap(request: IncomingMessage, response?: ServerResponse): Bootstrap {
    const id = cookie(request, "reach_console_bootstrap");
    const existing = id ? this.bootstraps.get(credentialDigest(id)) : undefined;
    if (existing && existing.expiresAt > this.now()) return existing;
    if (!response) throw new ConsoleError(403, "Load the sign-in page first", "CSRF_REJECTED");
    for (const [key, value] of this.bootstraps) if (value.expiresAt <= this.now()) this.bootstraps.delete(key);
    if (this.bootstraps.size >= 1024) this.bootstraps.delete(this.bootstraps.keys().next().value!);
    const nextId = randomBytes(32).toString("hex");
    const next = { csrfToken: randomBytes(32).toString("hex"), expiresAt: this.now() + recentMs };
    this.bootstraps.set(credentialDigest(nextId), next);
    response.setHeader("set-cookie", this.cookieValue("reach_console_bootstrap", nextId, recentMs / 1000));
    return next;
  }

  private signIn(request: IncomingMessage, response: ServerResponse, user: ConsoleUser): void {
    const id = randomBytes(32).toString("hex");
    const csrfToken = randomBytes(32).toString("hex");
    this.store.db.prepare("INSERT INTO console_sessions (digest,user_id,csrf_token,created_at,last_seen_at,reauthenticated_at) VALUES (?,?,?,?,?,?)")
      .run(credentialDigest(id), user.id, csrfToken, this.now(), this.now(), this.now());
    this.users.recordLogin(user.id);
    const bootstrapId = cookie(request, "reach_console_bootstrap");
    if (bootstrapId) this.bootstraps.delete(credentialDigest(bootstrapId));
    response.setHeader("set-cookie", [this.cookieValue("reach_console", id, absoluteMs / 1000), this.cookieValue("reach_console_bootstrap", "", 0)]);
    sendJson(response, 200, { authenticated: true, user: profile(user), csrfToken });
  }

  /** Counts a failed credential check toward rate limits and audits it. */
  failed(peer: string, route: string): void {
    this.limiter.failed(peer);
    this.events.authFailed(route, peer);
  }

  checkLimit(peer: string): void { this.limiter.check(peer); }

  /**
   * The one credential check shared by sign-in, OAuth approval and re-authentication. Unknown and disabled
   * accounts, wrong passwords and wrong codes all fail alike; only `fail` counts toward rate limits.
   * `totp_required` is returned only after a correct password when no code was supplied.
   */
  async verifyAccount(peer: string, route: string, username: unknown, password: unknown, code: unknown,
    options: { requireFactor?: boolean; role?: UserRole } = {}): Promise<AccountCheck> {
    const name = normalizeUsername(username);
    const candidate = name ? this.users.credentialsFor(name) : undefined;
    const usable = typeof password === "string" && password.length <= 1024;
    const passwordOk = usable && await verifyPassword(password, candidate?.passwordHash ?? await this.dummyHash) && Boolean(candidate);
    // The account may have changed while scrypt ran: decide on its current row, and only if the
    // password that was checked is still its password (a reset in between invalidates this attempt).
    const account = passwordOk && name ? this.users.credentialsFor(name) : undefined;
    let result: AccountCheck = { status: "fail" };
    if (account && account.id === candidate!.id && account.passwordHash === candidate!.passwordHash && !account.disabled
      && (!options.role || account.role === options.role)) {
      const factor = typeof code === "string" ? code.trim().replace(/\s+/g, "").toUpperCase() : "";
      if (options.requireFactor === false || !account.totpEnabled) result = { status: "ok", user: account };
      else if (!factor) result = { status: "totp_required", user: account };
      else if (this.users.credentials.acceptFactor(account.id, factor, this.now())) result = { status: "ok", user: account };
    }
    if (result.status === "fail") this.failed(peer, route);
    return result;
  }

  /** Verifies the signed-in user's current password, sharing rate limits; marks the session re-authenticated. */
  async confirmPassword(request: IncomingMessage, session: ConsoleSession, password: unknown, route: string): Promise<void> {
    const peer = this.peers.resolve(request);
    this.limiter.check(peer);
    const result = await this.verifyAccount(peer, route, session.user.username, password, undefined, { requireFactor: false });
    if (result.status !== "ok" || result.user.id !== session.user.id) throw new ConsoleError(401, "Invalid credentials", "INVALID_CREDENTIALS");
    this.store.db.prepare("UPDATE console_sessions SET reauthenticated_at=? WHERE digest=?").run(this.now(), session.digest);
  }

  setPendingTotp(session: ConsoleSession, secret: string | null): void {
    this.store.db.prepare("UPDATE console_sessions SET pending_totp_secret=?, pending_totp_expires_at=? WHERE digest=?")
      .run(secret, secret ? this.now() + recentMs : null, session.digest);
  }

  action(action: string, actor: Actor): void {
    const label = typeof actor === "string" ? actor : actor.username;
    this.events.emit("admin.action", { caller: { type: "console", label, verified: true }, action, outcome: "ok" });
  }

  async handle(path: string, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (!["me", "setup", "login", "logout", "reauth"].includes(path)) return false;
    response.setHeader("cache-control", "no-store");
    try {
      if (path === "me" && request.method === "GET") {
        const session = this.session(request);
        sendJson(response, 200, session ? { authenticated: true, user: session.user, csrfToken: session.csrfToken }
          : { authenticated: false, setupRequired: !this.users.any(), csrfToken: this.bootstrap(request, response).csrfToken });
        return true;
      }
      if (request.method !== "POST" || path === "me") throw new ConsoleError(405, "Method not allowed", "METHOD_NOT_ALLOWED");
      if (path === "setup" && this.users.any()) throw new ConsoleError(409, "Administrator already exists", "ADMIN_EXISTS");
      const peer = this.peers.resolve(request);
      if (["setup", "login", "reauth"].includes(path)) this.limiter.check(peer);
      let session: ConsoleSession | undefined;
      if (path === "logout" || path === "reauth") session = this.require(request, true);
      else this.checkCsrf(request, this.bootstrap(request).csrfToken);
      const value = await readJsonBody(request);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConsoleError(400, "Invalid request", "INVALID_REQUEST");
      const body = value as Record<string, unknown>;
      const route = `/api/console/${path}`;
      if (path === "setup") {
        if (!this.setupDigest || typeof body.token !== "string" || !equal(credentialDigest(body.token), this.setupDigest)) {
          this.failed(peer, route);
          throw new ConsoleError(403, "Invalid credentials", "INVALID_CREDENTIALS");
        }
        const username = normalizeUsername(body.username);
        if (!username) throw new ConsoleError(400, "Username must be 3 to 64 letters, digits, '.', '_' or '-'", "USERNAME_INVALID");
        if (!validPassword(body.password)) throw new ConsoleError(400, "Password must contain 12 to 1024 characters", "PASSWORD_LENGTH");
        const passwordHash = await hashPassword(body.password);
        if (this.users.any()) throw new ConsoleError(409, "Administrator already exists", "ADMIN_EXISTS");
        const user = this.users.create(username, passwordHash, "admin");
        this.setupDigest = undefined;
        if (!removeSetupToken(this.store.directory)) this.logger(LEFTOVER_SETUP_TOKEN);
        this.action(`admin.setup:${user.username}`, "Setup");
        this.signIn(request, response, user);
      } else if (path === "login") {
        const result = await this.verifyAccount(peer, route, body.username, body.password, body.code);
        if (result.status === "totp_required") throw new ConsoleError(401, "Authentication code required", "TOTP_REQUIRED");
        if (result.status === "fail") throw new ConsoleError(401, "Invalid credentials", "INVALID_CREDENTIALS");
        this.action("admin.login", profile(result.user));
        this.signIn(request, response, result.user);
      } else if (path === "logout") {
        this.store.db.prepare("DELETE FROM console_sessions WHERE digest=?").run(session!.digest);
        response.setHeader("set-cookie", this.cookieValue("reach_console", "", 0));
        this.action("admin.logout", session!.user);
        sendJson(response, 200, { authenticated: false });
      } else if (path === "reauth") {
        await this.confirmPassword(request, session!, body.password, route);
        this.action("admin.reauth", session!.user);
        sendJson(response, 200, { authenticated: true });
      }
    } catch (error) {
      if (error instanceof ConsoleError || error instanceof UserStoreError) {
        const retryAfter = error instanceof ConsoleError ? error.retryAfter : undefined;
        if (retryAfter) response.setHeader("retry-after", retryAfter);
        sendJson(response, error.status, { error: error.message, code: error.code, ...(retryAfter ? { retryAfter } : {}) });
      } else if (error instanceof PayloadTooLargeError) sendJson(response, 413, { error: "Body exceeds 64 KiB", code: "BODY_TOO_LARGE" });
      else sendJson(response, 400, { error: "Invalid console request", code: "INVALID_REQUEST" });
    }
    return true;
  }
}
