import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BlockList, isIP } from "node:net";
import { AdminCredentials, credentialDigest, hashPassword, newTotpSecret, verifyPassword, verifyTotp } from "./credentials.js";
import type { ConsoleConfig } from "./config.js";
import type { GatewayEvents } from "./events.js";
import { PayloadTooLargeError, readJsonBody, sendJson } from "./http.js";
import type { ConsoleStore } from "./store.js";
import { loadSetupToken, removeSetupToken } from "./setup-token.js";

const LEFTOVER_SETUP_TOKEN = "CONSOLE_SETUP_TOKEN_NOT_REMOVED: the administrator exists, so the leftover REACH_DATA_DIR/admin-setup-token is unusable; delete it manually";

const idleMs = 12 * 60 * 60 * 1000;
const absoluteMs = 7 * 24 * 60 * 60 * 1000;
const recentMs = 10 * 60 * 1000;

export class ConsoleError extends Error {
  constructor(readonly status: number, message: string, readonly code: string, readonly retryAfter?: number) { super(message); }
}

export interface AdminSession {
  digest: string;
  csrfToken: string;
  createdAt: number;
  lastSeenAt: number;
  reauthenticatedAt: number;
}

interface Bootstrap { csrfToken: string; expiresAt: number; secret?: string }

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
  private readonly credentials: AdminCredentials;
  readonly peers: PeerResolver;
  private readonly limiter: AuthRateLimiter;

  constructor(
    private readonly store: ConsoleStore,
    private readonly config: ConsoleConfig,
    private readonly events: GatewayEvents,
    private readonly now = Date.now,
    private readonly logger: (message: string) => void = console.log,
  ) {
    this.credentials = new AdminCredentials(store);
    this.peers = new PeerResolver(config.trustedProxies);
    this.limiter = new AuthRateLimiter(now);
    if (!this.hasAdmin()) {
      const token = config.setupToken || loadSetupToken(store.directory);
      this.setupDigest = credentialDigest(token);
      if (!config.setupToken) logger("Reach console setup credential: read REACH_DATA_DIR/admin-setup-token privately");
    } else if (!removeSetupToken(store.directory)) logger(LEFTOVER_SETUP_TOKEN);
  }

  private hasAdmin(): boolean { return Boolean(this.store.db.prepare("SELECT id FROM admin WHERE id=1").get()); }

  session(request: IncomingMessage): AdminSession | undefined {
    const id = cookie(request, "reach_console");
    if (!id || !/^[a-f0-9]{64}$/.test(id)) return undefined;
    const digest = credentialDigest(id);
    const row = this.store.db.prepare("SELECT * FROM console_sessions WHERE digest=?").get(digest);
    if (!row) return undefined;
    if (this.now() - Number(row.last_seen_at) >= idleMs || this.now() - Number(row.created_at) >= absoluteMs) {
      this.store.db.prepare("DELETE FROM console_sessions WHERE digest=?").run(digest);
      return undefined;
    }
    this.store.db.prepare("UPDATE console_sessions SET last_seen_at=? WHERE digest=?").run(this.now(), digest);
    return { digest, csrfToken: String(row.csrf_token), createdAt: Number(row.created_at), lastSeenAt: this.now(), reauthenticatedAt: Number(row.reauthenticated_at) };
  }

  require(request: IncomingMessage, mutation = false, recent = false): AdminSession {
    const session = this.session(request);
    if (!session) throw new ConsoleError(401, "Sign in required", "SIGN_IN_REQUIRED");
    if (mutation) this.checkCsrf(request, session.csrfToken);
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

  private signIn(request: IncomingMessage, response: ServerResponse, recoveryCodes?: string[]): void {
    const id = randomBytes(32).toString("hex");
    const csrfToken = randomBytes(32).toString("hex");
    this.store.db.prepare("INSERT INTO console_sessions VALUES (?,1,?,?,?,?)").run(credentialDigest(id), csrfToken, this.now(), this.now(), this.now());
    const bootstrapId = cookie(request, "reach_console_bootstrap");
    if (bootstrapId) this.bootstraps.delete(credentialDigest(bootstrapId));
    response.setHeader("set-cookie", [this.cookieValue("reach_console", id, absoluteMs / 1000), this.cookieValue("reach_console_bootstrap", "", 0)]);
    sendJson(response, 200, { authenticated: true, admin: { id: 1 }, csrfToken, ...(recoveryCodes ? { recoveryCodes } : {}) });
  }

  /** Verifies password and second factor for a non-console flow, sharing sign-in rate limits and audit. */
  async verifyOwner(request: IncomingMessage, route: string, password: unknown, code: unknown): Promise<boolean> {
    const peer = this.peers.resolve(request);
    this.limiter.check(peer);
    const admin = this.store.db.prepare("SELECT password_hash FROM admin WHERE id=1").get();
    const ok = Boolean(admin) && typeof password === "string" && password.length <= 1024 && await verifyPassword(password, String(admin!.password_hash))
      && typeof code === "string" && this.credentials.acceptFactor(code.trim().replace(/\s+/g, "").toUpperCase(), this.now());
    if (!ok) {
      this.limiter.failed(peer);
      this.events.authFailed(route, peer);
    }
    return ok;
  }

  action(action: string): void {
    this.events.emit("admin.action", { caller: { type: "console", label: "Administrator", verified: false }, action, outcome: "ok" });
  }

  async handle(path: string, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (!["me", "setup", "login", "logout", "reauth"].includes(path)) return false;
    response.setHeader("cache-control", "no-store");
    try {
      if (path === "me" && request.method === "GET") {
        const session = this.session(request);
        sendJson(response, 200, session ? { authenticated: true, admin: { id: 1 }, csrfToken: session.csrfToken }
          : { authenticated: false, setupRequired: !this.hasAdmin(), csrfToken: this.bootstrap(request, response).csrfToken });
        return true;
      }
      if (request.method !== "POST" || path === "me") throw new ConsoleError(405, "Method not allowed", "METHOD_NOT_ALLOWED");
      if (path === "setup" && this.hasAdmin()) throw new ConsoleError(409, "Administrator already exists", "ADMIN_EXISTS");
      const peer = this.peers.resolve(request);
      if (["setup", "login", "reauth"].includes(path)) this.limiter.check(peer);
      let session: AdminSession | undefined;
      let bootstrap: Bootstrap | undefined;
      if (path === "logout" || path === "reauth") session = this.require(request, true);
      else { bootstrap = this.bootstrap(request); this.checkCsrf(request, bootstrap.csrfToken); }
      const value = await readJsonBody(request);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConsoleError(400, "Invalid request", "INVALID_REQUEST");
      const body = value as Record<string, unknown>;
      const fail = (status = 401): never => {
        this.limiter.failed(peer);
        this.events.authFailed(`/api/console/${path}`, peer);
        throw new ConsoleError(status, "Invalid credentials", "INVALID_CREDENTIALS");
      };
      if (path === "setup") {
        if (!this.setupDigest || typeof body.token !== "string" || !equal(credentialDigest(body.token), this.setupDigest)) fail(403);
        if (body.password === undefined) {
          bootstrap!.secret ??= newTotpSecret();
          const secret = bootstrap!.secret;
          sendJson(response, 200, { secret, otpauthUrl: `otpauth://totp/Reach:Administrator?secret=${secret}&issuer=Reach&algorithm=SHA1&digits=6&period=30` });
          return true;
        }
        if (typeof body.password !== "string" || body.password.length < 12 || body.password.length > 1024) throw new ConsoleError(400, "Password must contain 12 to 1024 characters", "PASSWORD_LENGTH");
        const step = bootstrap!.secret && typeof body.code === "string" ? verifyTotp(bootstrap!.secret, body.code, -1, this.now()) : undefined;
        if (step === undefined) fail(403);
        const passwordHash = await hashPassword(body.password);
        if (this.hasAdmin()) throw new ConsoleError(409, "Administrator already exists", "ADMIN_EXISTS");
        const recovery = this.credentials.createAdmin(passwordHash, bootstrap!.secret!, step!, this.now());
        this.setupDigest = undefined;
        if (!removeSetupToken(this.store.directory)) this.logger(LEFTOVER_SETUP_TOKEN);
        this.action("admin.setup");
        this.signIn(request, response, recovery);
      } else if (path === "login") {
        const admin = this.store.db.prepare("SELECT password_hash FROM admin WHERE id=1").get();
        if (!admin || typeof body.password !== "string" || body.password.length > 1024 || !await verifyPassword(body.password, String(admin.password_hash))) fail();
        if (typeof body.code !== "string" || !this.credentials.acceptFactor(body.code, this.now())) fail();
        this.action("admin.login");
        this.signIn(request, response);
      } else if (path === "logout") {
        this.store.db.prepare("DELETE FROM console_sessions WHERE digest=?").run(session!.digest);
        response.setHeader("set-cookie", this.cookieValue("reach_console", "", 0));
        this.action("admin.logout");
        sendJson(response, 200, { authenticated: false });
      } else if (path === "reauth") {
        const admin = this.store.db.prepare("SELECT password_hash FROM admin WHERE id=1").get();
        if (!admin || typeof body.password !== "string" || body.password.length > 1024 || !await verifyPassword(body.password, String(admin.password_hash))) fail();
        this.store.db.prepare("UPDATE console_sessions SET reauthenticated_at=? WHERE digest=?").run(this.now(), session!.digest);
        this.action("admin.reauth");
        sendJson(response, 200, { authenticated: true });
      }
    } catch (error) {
      if (error instanceof ConsoleError) {
        if (error.retryAfter) response.setHeader("retry-after", error.retryAfter);
        sendJson(response, error.status, { error: error.message, code: error.code, ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) });
      } else if (error instanceof PayloadTooLargeError) sendJson(response, 413, { error: "Body exceeds 64 KiB", code: "BODY_TOO_LARGE" });
      else sendJson(response, 400, { error: "Invalid console request", code: "INVALID_REQUEST" });
    }
    return true;
  }
}
