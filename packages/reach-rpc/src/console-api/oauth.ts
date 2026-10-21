import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConsoleAuth } from "./auth.js";
import { ConsoleError } from "./auth.js";
import type { ConsoleConfig } from "./config.js";
import { credentialDigest } from "./credentials.js";
import { MAX_HTTP_BODY_BYTES } from "../gateway-policy.js";
import type { ConsoleStore } from "./store.js";
import type { ClientAccess } from "./client-access.js";
import { parseClientPermissions, type ClientPermission } from "../client-policy.js";

/** Resource rows on the consent page; the parser rejects anything beyond it rather than dropping it. */
const MAX_CONSENT_ROWS = 128;

const accessTtlMs = 60 * 60 * 1000;
const refreshTtlMs = 30 * 24 * 60 * 60 * 1000;
const codeTtlMs = 5 * 60 * 1000;
const pendingTtlMs = 10 * 60 * 1000;
const unapprovedTtlMs = 60 * 60 * 1000;
const maxUnapprovedClients = 256;
const registrationsPerPeer = 20;
const scope = "reach";
const authMethods = ["none", "client_secret_post", "client_secret_basic"] as const;
type AuthMethod = typeof authMethods[number];

export interface OAuthClient { id: string; name: string }

interface ClientRow { id: string; name: string; redirectUris: string[]; authMethod: AuthMethod; secretDigest: string | null }

/** Carried by the approval form, signed by the Gateway, so no server state can be crowded out. */
interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  state?: string;
  challenge: string;
  expiresAt: number;
}

interface AuthorizationCode { clientId: string; redirectUri: string; challenge: string; expiresAt: number; revision: number }

export interface OAuthResource { engineId: string; workspaces?: readonly string[] }

class OAuthError extends Error {
  constructor(readonly status: number, readonly error: string, description: string, readonly retryAfter?: number) { super(description); }
}

function equal(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
}

function clean(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 64) || fallback : fallback;
}

/** Redirect URIs must be HTTPS, or plain HTTP only on loopback for local clients. */
function validRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return !url.hash && !url.username && !url.password && (url.protocol === "https:" || url.protocol === "http:" && loopback);
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (Number(request.headers["content-length"] ?? 0) > MAX_HTTP_BODY_BYTES) throw new OAuthError(413, "invalid_request", "Body exceeds 64 KiB");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_HTTP_BODY_BYTES) throw new OAuthError(413, "invalid_request", "Body exceeds 64 KiB");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const type = request.headers["content-type"]?.split(";")[0].trim().toLowerCase();
  if (type === "application/json") {
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new OAuthError(400, "invalid_request", "Invalid JSON"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new OAuthError(400, "invalid_request", "Expected a JSON object");
    return value as Record<string, unknown>;
  }
  if (type === "application/x-www-form-urlencoded") return Object.fromEntries(new URLSearchParams(text));
  throw new OAuthError(415, "invalid_request", "Unsupported content type");
}

function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store", ...headers });
  response.end(text);
}

function redirect(response: ServerResponse, target: string): void {
  response.writeHead(302, { location: target, "cache-control": "no-store" });
  response.end();
}

/**
 * OAuth 2.1 authorization server for remote MCP clients such as ChatGPT connectors.
 * Implements the MCP authorization profile: protected resource metadata (RFC 9728),
 * authorization server metadata (RFC 8414), dynamic client registration (RFC 7591),
 * authorization code with S256 PKCE, rotating refresh tokens and revocation (RFC 7009).
 * The Gateway owner approves each authorization with the console password and TOTP.
 */
export class OAuthServer {
  readonly issuer: string;
  readonly resource: string;
  private readonly codes = new Map<string, AuthorizationCode>();
  private readonly requestKey = randomBytes(32);
  private readonly registrations = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly store: ConsoleStore,
    config: ConsoleConfig,
    private readonly auth: ConsoleAuth,
    private readonly now = Date.now,
    private readonly access?: ClientAccess,
    private readonly resources: () => readonly OAuthResource[] = () => [],
  ) {
    this.issuer = config.publicOrigin;
    this.resource = `${config.publicOrigin}/mcp`;
  }

  /** WWW-Authenticate challenge pointing MCP clients at the protected resource metadata. */
  challenge(invalidToken: boolean): string {
    return `Bearer resource_metadata="${this.issuer}/.well-known/oauth-protected-resource/mcp"${invalidToken ? ', error="invalid_token"' : ""}`;
  }

  /** Returns the client behind a live access token, or undefined. */
  verify(authorization: string | undefined): OAuthClient | undefined {
    if (!authorization?.startsWith("Bearer ")) return undefined;
    const token = authorization.slice(7).trim();
    if (!/^reach_at_[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const row = this.store.db.prepare(`SELECT c.id, c.name, c.last_used_at FROM oauth_tokens t JOIN oauth_clients c ON c.id = t.client_id
      WHERE t.digest=? AND t.kind='access' AND t.expires_at > ?`).get(credentialDigest(token), this.now());
    if (!row || !this.active(String(row.id))) return undefined;
    if (this.now() - Number(row.last_used_at ?? 0) >= 60_000) this.store.db.prepare("UPDATE oauth_clients SET last_used_at=? WHERE id=?").run(this.now(), row.id);
    return { id: String(row.id), name: String(row.name) };
  }

  /** Approved clients for the console. */
  clients(): Array<{ id: string; name: string; redirectUris: string[]; approvedAt: number; lastUsedAt: number | null; activeTokens: number }> {
    return this.store.db.prepare(`SELECT c.*, (SELECT count(*) FROM oauth_tokens t WHERE t.client_id=c.id AND t.used_at IS NULL AND t.expires_at > ?) AS active
      FROM oauth_clients c WHERE c.approved_at IS NOT NULL ORDER BY c.approved_at DESC`).all(this.now()).map(row => ({
      id: String(row.id), name: String(row.name), redirectUris: JSON.parse(String(row.redirect_uris)) as string[],
      approvedAt: Number(row.approved_at), lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at), activeTokens: Number(row.active),
    }));
  }

  /** Removes a client registration and every token it holds; returns false when unknown. */
  revoke(clientId: string): boolean {
    for (const [key, code] of this.codes) if (code.clientId === clientId) this.codes.delete(key);
    if (this.access && this.store.db.prepare("SELECT id FROM client_principals WHERE oauth_client_id=?").get(clientId)) this.access.revoke(`oauth:${clientId}`);
    const removed = this.store.db.prepare("DELETE FROM oauth_clients WHERE id=?").run(clientId).changes === 1;
    this.access?.invalidate();
    return removed;
  }

  private active(clientId: string): boolean {
    if (!this.access) return false;
    try { return this.access.get(`oauth:${clientId}`).revokedAt === null; } catch { return false; }
  }

  async handle(url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const path = url.pathname;
    if (!path.startsWith("/.well-known/oauth-") && !path.startsWith("/oauth/")) return false;
    try {
      if (request.method === "OPTIONS" && path.startsWith("/.well-known/")) {
        response.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET", "access-control-allow-headers": "mcp-protocol-version" });
        response.end();
      } else if (request.method === "GET" && (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp")) {
        send(response, 200, {
          resource: this.resource, authorization_servers: [this.issuer], bearer_methods_supported: ["header"],
          scopes_supported: [scope], resource_name: "Reach Gateway",
        }, { "access-control-allow-origin": "*", "cache-control": "max-age=300" });
      } else if (request.method === "GET" && (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/oauth-authorization-server/mcp")) {
        send(response, 200, {
          issuer: this.issuer,
          authorization_endpoint: `${this.issuer}/oauth/authorize`,
          token_endpoint: `${this.issuer}/oauth/token`,
          registration_endpoint: `${this.issuer}/oauth/register`,
          revocation_endpoint: `${this.issuer}/oauth/revoke`,
          scopes_supported: [scope],
          response_types_supported: ["code"],
          response_modes_supported: ["query"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: authMethods,
          revocation_endpoint_auth_methods_supported: authMethods,
          authorization_response_iss_parameter_supported: true,
        }, { "access-control-allow-origin": "*", "cache-control": "max-age=300" });
      } else if (request.method === "POST" && path === "/oauth/register") await this.register(request, response);
      else if (request.method === "GET" && path === "/oauth/authorize") this.authorize(url, response);
      else if (request.method === "POST" && path === "/oauth/authorize") await this.decide(request, response);
      else if (request.method === "POST" && path === "/oauth/token") await this.token(request, response);
      else if (request.method === "POST" && path === "/oauth/revoke") await this.revocation(request, response);
      else send(response, 404, { error: "not_found" });
    } catch (error) {
      if (response.headersSent) { response.destroy(); return true; }
      if (error instanceof OAuthError) send(response, error.status, { error: error.error, error_description: error.message },
        error.retryAfter ? { "retry-after": String(error.retryAfter) } : {});
      else if (error instanceof ConsoleError && error.status === 429) {
        if (error.retryAfter) response.setHeader("retry-after", error.retryAfter);
        this.page(response, 429, "Too many attempts", `<p>Too many failed approvals. Try again later.</p>`);
      } else send(response, 500, { error: "server_error", error_description: "Authorization storage unavailable" });
    }
    return true;
  }

  private client(id: unknown): ClientRow | undefined {
    if (typeof id !== "string" || id.length > 64) return undefined;
    const row = this.store.db.prepare("SELECT * FROM oauth_clients WHERE id=?").get(id);
    if (!row) return undefined;
    return { id: String(row.id), name: String(row.name), redirectUris: JSON.parse(String(row.redirect_uris)) as string[],
      authMethod: String(row.auth_method) as AuthMethod, secretDigest: row.secret_digest === null ? null : String(row.secret_digest) };
  }

  private async register(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.limitRegistration(request);
    const body = await readBody(request);
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 8 || !uris.every(validRedirectUri)) {
      throw new OAuthError(400, "invalid_redirect_uri", "redirect_uris must list 1 to 8 HTTPS (or loopback HTTP) URIs without fragments");
    }
    const method = (body.token_endpoint_auth_method ?? "none") as AuthMethod;
    if (!authMethods.includes(method)) throw new OAuthError(400, "invalid_client_metadata", "Unsupported token_endpoint_auth_method");
    const grants = body.grant_types ?? ["authorization_code"];
    if (!Array.isArray(grants) || !grants.includes("authorization_code") || grants.some(grant => grant !== "authorization_code" && grant !== "refresh_token")) {
      throw new OAuthError(400, "invalid_client_metadata", "grant_types must include authorization_code and may add refresh_token");
    }
    const responses = body.response_types ?? ["code"];
    if (!Array.isArray(responses) || responses.some(type => type !== "code")) throw new OAuthError(400, "invalid_client_metadata", "response_types must be [\"code\"]");
    const id = randomUUID();
    const secret = method === "none" ? undefined : randomBytes(32).toString("base64url");
    const name = clean(body.client_name, "OAuth client");
    const issuedAt = this.now();
    const accepted = this.store.transaction(() => {
      // Registration is anonymous: only idle, never-approved registrations expire, and a full table refuses
      // new ones instead of evicting a registration whose owner may be mid-approval.
      this.store.db.prepare("DELETE FROM oauth_clients WHERE approved_at IS NULL AND coalesce(last_used_at, created_at) <= ?").run(issuedAt - unapprovedTtlMs);
      this.access?.invalidate();
      const unapproved = Number(this.store.db.prepare("SELECT count(*) AS n FROM oauth_clients WHERE approved_at IS NULL").get()!.n);
      if (unapproved >= maxUnapprovedClients) return false;
      this.store.db.prepare("INSERT INTO oauth_clients(id,name,redirect_uris,auth_method,secret_digest,created_at) VALUES (?,?,?,?,?,?)")
        .run(id, name, JSON.stringify(uris), method, secret ? credentialDigest(secret) : null, issuedAt);
      return true;
    });
    if (!accepted) throw new OAuthError(503, "temporarily_unavailable", "Too many pending registrations; try again later", 600);
    send(response, 201, {
      client_id: id, client_id_issued_at: Math.floor(issuedAt / 1000), client_name: name, redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: method, scope,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    });
  }

  private limitRegistration(request: IncomingMessage): void {
    const peer = this.auth.peers.resolve(request);
    const now = this.now();
    let bucket = this.registrations.get(peer);
    if (!bucket || bucket.resetAt <= now) {
      for (const [key, value] of this.registrations) if (value.resetAt <= now) this.registrations.delete(key);
      if (this.registrations.size >= 10_000) throw new OAuthError(429, "temporarily_unavailable", "Too many registrations; try again later", 3600);
      bucket = { count: 0, resetAt: now + unapprovedTtlMs };
      this.registrations.set(peer, bucket);
    }
    if (++bucket.count > registrationsPerPeer) throw new OAuthError(429, "temporarily_unavailable", "Too many registrations; try again later", Math.ceil((bucket.resetAt - now) / 1000));
  }

  private signRequest(request: AuthorizationRequest): string {
    const payload = Buffer.from(JSON.stringify(request)).toString("base64url");
    return `${payload}.${createHmac("sha256", this.requestKey).update(payload).digest("base64url")}`;
  }

  private openRequest(value: unknown): AuthorizationRequest | undefined {
    if (typeof value !== "string" || value.length > 4096) return undefined;
    const [payload, signature, extra] = value.split(".");
    if (!payload || !signature || extra !== undefined
      || !equal(signature, createHmac("sha256", this.requestKey).update(payload).digest("base64url"))) return undefined;
    const request = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AuthorizationRequest;
    return request.expiresAt > this.now() ? request : undefined;
  }

  private authorize(url: URL, response: ServerResponse): void {
    const params = url.searchParams;
    const client = this.client(params.get("client_id"));
    if (!client) { this.page(response, 400, "Unknown application", "<p>This application is not registered with the Gateway. Remove and add the connector again.</p>"); return; }
    const redirectUri = params.get("redirect_uri") ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : "");
    if (!client.redirectUris.includes(redirectUri)) { this.page(response, 400, "Invalid redirect", "<p>The redirect URI does not match the application's registration.</p>"); return; }
    const state = params.get("state") ?? undefined;
    const fail = (error: string, description: string) => redirect(response, this.callback(redirectUri, { error, error_description: description, state }));
    if (params.get("response_type") !== "code") { fail("unsupported_response_type", "Only response_type=code is supported"); return; }
    const challenge = params.get("code_challenge") ?? "";
    if (params.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) { fail("invalid_request", "PKCE with code_challenge_method=S256 is required"); return; }
    const resource = params.get("resource");
    if (resource !== null && resource.replace(/\/$/, "") !== this.resource && resource.replace(/\/$/, "") !== this.issuer) { fail("invalid_target", "Unknown resource"); return; }
    if (!this.store.db.prepare("SELECT id FROM admin WHERE id=1").get()) { this.page(response, 503, "Gateway not set up", "<p>Finish the Gateway console setup before connecting applications.</p>"); return; }
    // Keeps an unapproved registration alive while its owner is using it.
    this.store.db.prepare("UPDATE oauth_clients SET last_used_at=? WHERE id=? AND approved_at IS NULL").run(this.now(), client.id);
    const signed = this.signRequest({ clientId: client.id, redirectUri, state, challenge, expiresAt: this.now() + pendingTtlMs });
    this.consent(response, signed, client, redirectUri);
  }

  private async decide(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Browsers send Origin on same-origin form posts; Sec-Fetch-Site covers browsers that still send "null".
    const origin = request.headers.origin;
    if (origin !== this.issuer && !((origin === undefined || origin === "null") && request.headers["sec-fetch-site"] === "same-origin")) {
      this.page(response, 403, "Request rejected", "<p>The approval did not come from this Gateway's page.</p>");
      return;
    }
    const body = await readBody(request);
    const signed = typeof body.request === "string" ? body.request : "";
    const pending = this.openRequest(signed);
    const client = pending && this.client(pending.clientId);
    if (!pending || !client) {
      this.page(response, 400, "Request expired", "<p>This authorization request has expired. Start the connection again from the application.</p>");
      return;
    }
    if (body.decision !== "approve") {
      redirect(response, this.callback(pending.redirectUri, { error: "access_denied", error_description: "The Gateway owner denied access", state: pending.state }));
      return;
    }
    if (!await this.auth.verifyOwner(request, "/oauth/authorize", body.password, body.code)) {
      this.consent(response, signed, client, pending.redirectUri, "Password or authentication code is incorrect. Each code works once; wait for the next one if you just signed in.");
      return;
    }
    let permissions: ClientPermission[];
    try {
      const rows: unknown[] = [];
      const indexes = new Set<number>();
      for (const key of Object.keys(body)) {
        const match = /^permission\.(\d{1,4})\.(?:engineId|workspace|read|write|execute)$/.exec(key);
        if (key.startsWith("permission.") && !match) throw new Error("Unknown permission field");
        if (match) indexes.add(Number(match[1]));
      }
      // Every posted row is considered; a row beyond what the page can render is an error, never dropped.
      if ([...indexes].some(index => index >= MAX_CONSENT_ROWS)) throw new Error("Too many resource rows");
      for (const index of [...indexes].sort((a, b) => a - b)) {
        const prefix = `permission.${index}.`;
        if (!["read", "write", "execute"].some(operation => body[prefix + operation] === "on")) continue;
        rows.push({ engineId: body[prefix + "engineId"], workspace: body[prefix + "workspace"],
          read: body[prefix + "read"] === "on", write: body[prefix + "write"] === "on", execute: body[prefix + "execute"] === "on" });
      }
      permissions = parseClientPermissions(rows);
      const resources = this.resources();
      if (!permissions.length || permissions.some(permission => {
        const resource = resources.find(resource => resource.engineId === permission.engineId);
        return !resource || resource.workspaces && !resource.workspaces.includes(permission.workspace);
      })) throw new Error("Invalid resource selection");
    } catch {
      this.consent(response, signed, client, pending.redirectUri, "Select registered Engines, workspace names and permissions. No access is selected by default.", 400);
      return;
    }
    if (!this.access) throw new OAuthError(503, "temporarily_unavailable", "Client policy storage unavailable");
    const approved = this.access.approveOAuth(client.id, client.name, permissions);
    this.store.db.prepare("UPDATE oauth_clients SET approved_at=coalesce(approved_at, ?) WHERE id=?").run(this.now(), client.id);
    for (const [key, value] of this.codes) if (value.expiresAt <= this.now()) this.codes.delete(key);
    const code = randomBytes(32).toString("base64url");
    this.codes.set(credentialDigest(code), { clientId: client.id, redirectUri: pending.redirectUri, challenge: pending.challenge, expiresAt: this.now() + codeTtlMs, revision: approved.policyRevision });
    this.auth.action(`oauth.authorize:${client.name}`);
    redirect(response, this.callback(pending.redirectUri, { code, state: pending.state }));
  }

  private callback(redirectUri: string, values: Record<string, string | undefined>): string {
    const target = new URL(redirectUri);
    for (const [key, value] of Object.entries({ ...values, iss: this.issuer })) if (value !== undefined) target.searchParams.set(key, value);
    return target.toString();
  }

  /** Authenticates the calling client at the token and revocation endpoints. */
  private authenticateClient(request: IncomingMessage, body: Record<string, unknown>): ClientRow {
    let id = body.client_id;
    let secret = body.client_secret;
    const header = request.headers.authorization;
    let method: AuthMethod = secret === undefined ? "none" : "client_secret_post";
    if (header?.startsWith("Basic ")) {
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      if (separator < 0) throw new OAuthError(401, "invalid_client", "Malformed client credentials");
      id = decodeURIComponent(decoded.slice(0, separator));
      secret = decodeURIComponent(decoded.slice(separator + 1));
      method = "client_secret_basic";
    }
    const client = this.client(id);
    if (!client) throw new OAuthError(401, "invalid_client", "Unknown client");
    if (client.authMethod === "none") {
      if (method !== "none") throw new OAuthError(401, "invalid_client", "Public clients must not send a secret");
    } else if (method === "none" || typeof secret !== "string" || !client.secretDigest || !equal(credentialDigest(secret), client.secretDigest)) {
      throw new OAuthError(401, "invalid_client", "Client authentication failed");
    }
    return client;
  }

  private issue(clientId: string, family: string): Record<string, unknown> {
    const access = `reach_at_${randomBytes(32).toString("base64url")}`;
    const refresh = `reach_rt_${randomBytes(32).toString("base64url")}`;
    const insert = this.store.db.prepare("INSERT INTO oauth_tokens(digest,kind,client_id,family,expires_at) VALUES (?,?,?,?,?)");
    insert.run(credentialDigest(access), "access", clientId, family, this.now() + accessTtlMs);
    insert.run(credentialDigest(refresh), "refresh", clientId, family, this.now() + refreshTtlMs);
    this.store.db.prepare("DELETE FROM oauth_tokens WHERE expires_at <= ?").run(this.now());
    return { access_token: access, token_type: "Bearer", expires_in: accessTtlMs / 1000, refresh_token: refresh, scope };
  }

  private async token(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request);
    const client = this.authenticateClient(request, body);
    const resource = body.resource;
    if (resource !== undefined && (typeof resource !== "string" || ![this.resource, this.issuer].includes(resource.replace(/\/$/, "")))) {
      throw new OAuthError(400, "invalid_target", "Unknown resource");
    }
    if (body.grant_type === "authorization_code") {
      const code = typeof body.code === "string" ? body.code : "";
      const digest = credentialDigest(code);
      const grant = this.codes.get(digest);
      this.codes.delete(digest);
      if (!grant || grant.expiresAt <= this.now() || grant.clientId !== client.id || !this.active(client.id)
        || this.access!.get(`oauth:${client.id}`).policyRevision !== grant.revision) throw new OAuthError(400, "invalid_grant", "Authorization code is invalid or expired");
      if (body.redirect_uri !== undefined && body.redirect_uri !== grant.redirectUri) throw new OAuthError(400, "invalid_grant", "redirect_uri does not match");
      const verifier = typeof body.code_verifier === "string" ? body.code_verifier : "";
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !equal(createHash("sha256").update(verifier).digest("base64url"), grant.challenge)) {
        throw new OAuthError(400, "invalid_grant", "PKCE verification failed");
      }
      send(response, 200, this.store.transaction(() => this.issue(client.id, randomUUID())));
      return;
    }
    if (body.grant_type === "refresh_token") {
      if (!this.active(client.id)) throw new OAuthError(400, "invalid_grant", "Client authorization is revoked");
      const token = typeof body.refresh_token === "string" ? body.refresh_token : "";
      let replayed = false;
      const result = this.store.transaction(() => {
        const row = this.store.db.prepare("SELECT * FROM oauth_tokens WHERE digest=? AND kind='refresh'").get(credentialDigest(token));
        if (!row || row.client_id !== client.id || Number(row.expires_at) <= this.now()) return undefined;
        if (row.used_at !== null) {
          // A rotated refresh token was replayed: revoke the whole grant family.
          this.store.db.prepare("DELETE FROM oauth_tokens WHERE family=?").run(row.family);
          replayed = true;
          return undefined;
        }
        this.store.db.prepare("UPDATE oauth_tokens SET used_at=? WHERE digest=?").run(this.now(), row.digest);
        this.store.db.prepare("DELETE FROM oauth_tokens WHERE family=? AND kind='access'").run(row.family);
        return this.issue(client.id, String(row.family));
      });
      if (replayed) this.access?.invalidateOAuth(client.id);
      if (!result) throw new OAuthError(400, "invalid_grant", "Refresh token is invalid, expired or revoked");
      send(response, 200, result);
      return;
    }
    throw new OAuthError(400, "unsupported_grant_type", "Use authorization_code or refresh_token");
  }

  private async revocation(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request);
    const client = this.authenticateClient(request, body);
    if (typeof body.token === "string") {
      const row = this.store.db.prepare("SELECT family FROM oauth_tokens WHERE digest=? AND client_id=?").get(credentialDigest(body.token), client.id);
      if (row) {
        this.store.db.prepare("DELETE FROM oauth_tokens WHERE family=?").run(row.family);
        this.access?.invalidateOAuth(client.id);
      }
    }
    send(response, 200, {});
  }

  private consent(response: ServerResponse, id: string, client: ClientRow, redirectUri: string, error?: string, status = 401): void {
    const host = new URL(redirectUri).host;
    let index = 0;
    const rows = this.resources().flatMap(resource => (resource.workspaces ?? ["", "", ""]).map(workspace => ({ resource, workspace })));
    const truncated = rows.length > MAX_CONSENT_ROWS;
    const choices = rows.slice(0, MAX_CONSENT_ROWS).map(({ resource, workspace }) => {
      const prefix = `permission.${index++}.`;
      return `<fieldset><legend>${escapeHtml(resource.engineId)}</legend>
        <input type="hidden" name="${prefix}engineId" value="${escapeHtml(resource.engineId)}">
        <label>Workspace<input name="${prefix}workspace" value="${escapeHtml(workspace)}"${workspace ? " readonly" : ""} placeholder="Configured workspace name"></label>
        ${["read", "write", "execute"].map(operation => `<label class="choice"><input type="checkbox" name="${prefix}${operation}"> ${operation}</label>`).join("")}</fieldset>`;
    }).join("") + (truncated ? `<p class="muted">Only the first ${MAX_CONSENT_ROWS} resource rows are shown. Approve with these, then add other resources from the console's Clients page.</p>` : "");
    this.page(response, error ? status : 200, "Connect to Reach Gateway", `
      <p><strong>${escapeHtml(client.name)}</strong> wants to use this Gateway's MCP tools. Select each Engine, workspace and operation you trust this application to use.</p>
      <p>Execute runs trusted Node scripts with the Engine account's operating system privileges. It is not a sandbox. File write permission can change scripts that another trusted client may execute.</p>
      <p class="muted">After approval you will return to <code>${escapeHtml(host)}</code>.</p>
      ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
      <form method="post" action="/oauth/authorize">
        <input type="hidden" name="request" value="${escapeHtml(id)}">
        ${choices || "<p>No registered Engines. Register an Engine in the console first.</p>"}
        <label>Administrator password<input type="password" name="password" autocomplete="current-password" required autofocus></label>
        <label>Authentication code or recovery code<input name="code" autocomplete="one-time-code" inputmode="text" required></label>
        <div class="actions">
          <button type="submit" name="decision" value="approve">Approve</button>
          <button type="submit" name="decision" value="deny" formnovalidate class="secondary">Deny</button>
        </div>
      </form>`, new URL(redirectUri).origin);
  }

  private page(response: ServerResponse, status: number, title: string, content: string, formTarget?: string): void {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>
body{font:15px/1.5 system-ui,sans-serif;background:#f6f6f4;color:#1c1c1a;margin:0;padding:48px 16px}
main{max-width:420px;margin:0 auto;background:#fff;border:1px solid #e3e3df;border-radius:12px;padding:28px}
h1{font-size:20px;margin:0 0 12px}.muted{color:#66665f}.error{color:#b42318}
label{display:block;margin:14px 0 0;font-weight:500}input{display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:9px 10px;border:1px solid #cfcfc9;border-radius:8px;font:inherit}
fieldset{margin-top:16px;border:1px solid #cfcfc9;border-radius:8px}.choice{display:inline-block;margin-right:12px}.choice input{display:inline;width:auto}
.actions{display:flex;gap:8px;margin-top:20px}button{flex:1;padding:10px;border-radius:8px;border:1px solid #1c1c1a;background:#1c1c1a;color:#fff;font:inherit;cursor:pointer}
button.secondary{background:#fff;color:#1c1c1a}code{font-size:13px}
</style></head><body><main><h1>${escapeHtml(title)}</h1>${content}</main></body></html>`;
    // Form submission redirects to the client, so form-action must allow its origin.
    response.writeHead(status, {
      "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(html), "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${formTarget ? ` ${formTarget}` : ""}; frame-ancestors 'none'; base-uri 'none'`,
            // no-referrer would make browsers send `Origin: null` on the approval form post.
      "x-content-type-options": "nosniff", "referrer-policy": "same-origin",
    });
    response.end(html);
  }
}
