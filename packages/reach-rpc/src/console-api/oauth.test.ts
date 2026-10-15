import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createGateway } from "../gateway.js";
import { totp } from "./credentials.js";

const origin = "https://gateway.example.com";
const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
const password = "a long owner password";
const mcpHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "openai-mcp", version: "1.0.0" } } };

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "reach-oauth-"));
  let now = Date.now();
  const gateway = createGateway({ logger: () => {}, now: () => now, heartbeatIntervalSeconds: 1,
    authentication: { controllerToken: "c".repeat(48), engineToken: "e".repeat(48), engineId: "engine-a" },
    console: { dataDir: directory, publicOrigin: origin, setupToken: "setup-token", trustedProxies: [], retentionDays: 30 },
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const address = gateway.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;

  // Console setup and a signed-in session for the console API.
  const cookies = new Map<string, string>();
  let csrf = "";
  const consoleCall = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(`${base}/api/console/${path}`, { method, headers: { origin, "content-type": "application/json", "x-csrf-token": csrf,
      cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; ") }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const value of response.headers.getSetCookie()) { const pair = value.split(";")[0]; const at = pair.indexOf("="); cookies.set(pair.slice(0, at), pair.slice(at + 1)); }
    const data = await response.json() as Record<string, any>;
    if (data.csrfToken) csrf = data.csrfToken;
    return { response, data };
  };
  await consoleCall("me");
  const secret = (await consoleCall("setup", { token: "setup-token" })).data.secret as string;
  assert.equal((await consoleCall("setup", { token: "setup-token", password, code: totp(secret, now) })).response.status, 200);

  const form = (path: string, values: Record<string, string>, headers: Record<string, string> = {}) => fetch(`${base}${path}`, {
    method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(values).toString(),
  });
  const register = async (metadata: Record<string, unknown> = {}) => {
    const response = await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", ...metadata }) });
    assert.equal(response.status, 201);
    return response.json() as Promise<Record<string, any>>;
  };
  /** Runs the browser part of the flow and returns the redirect back to the client. */
  const approve = async (clientId: string, verifier: string, decision = "approve") => {
    const query = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, state: "state-1",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource: `${origin}/mcp`, scope: "reach" });
    const page = await fetch(`${base}/oauth/authorize?${query}`);
    assert.equal(page.status, 200);
    // no-referrer would make browsers send `Origin: null` on the form post.
    assert.equal(page.headers.get("referrer-policy"), "same-origin");
    assert.match(page.headers.get("content-security-policy")!, /form-action 'self' https:\/\/chatgpt\.com/);
    const html = await page.text();
    assert.match(html, /wants to use this Gateway/);
    const request = /name="request" value="([^"]+)"/.exec(html)![1];
    now += 30_000; // A fresh TOTP step; the setup code was consumed.
    return form("/oauth/authorize", { request, password, code: totp(secret, now), decision }, { origin });
  };
  /** Completes authorization for a public client and returns its tokens. */
  const grant = async (clientId: string) => {
    const verifier = randomBytes(32).toString("base64url");
    const code = new URL((await approve(clientId, verifier)).headers.get("location")!).searchParams.get("code")!;
    const response = await form("/oauth/token", { grant_type: "authorization_code", code, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier });
    assert.equal(response.status, 200);
    return response.json() as Promise<Record<string, any>>;
  };
  return { base, gateway, consoleCall, form, register, approve, grant, advance: (ms: number) => { now += ms; },
    close: async () => { await new Promise<void>(resolve => gateway.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); } };
}

test("ChatGPT-style OAuth flow discovers, registers, approves and calls MCP with rotating tokens", async () => {
  const f = await fixture();
  try {
    const challenge = await fetch(`${f.base}/mcp`, { method: "POST", headers: mcpHeaders, body: JSON.stringify(initialize) });
    assert.equal(challenge.status, 401);
    assert.equal(challenge.headers.get("www-authenticate"), `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);
    const resource = await (await fetch(`${f.base}/.well-known/oauth-protected-resource/mcp`)).json() as Record<string, any>;
    assert.deepEqual([resource.resource, resource.authorization_servers], [`${origin}/mcp`, [origin]]);
    const metadata = await (await fetch(`${f.base}/.well-known/oauth-authorization-server`)).json() as Record<string, any>;
    assert.equal(metadata.registration_endpoint, `${origin}/oauth/register`);
    assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);

    const client = await f.register();
    const verifier = randomBytes(32).toString("base64url");
    const approved = await f.approve(client.client_id, verifier);
    assert.equal(approved.status, 302);
    const callback = new URL(approved.headers.get("location")!);
    assert.equal(`${callback.origin}${callback.pathname}`, redirectUri);
    assert.equal(callback.searchParams.get("state"), "state-1");
    assert.equal(callback.searchParams.get("iss"), origin);
    const code = callback.searchParams.get("code")!;

    const wrongVerifier = await f.form("/oauth/token", { grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: redirectUri, code_verifier: "x".repeat(43) });
    assert.equal(wrongVerifier.status, 400);
    // A failed exchange consumes the code.
    const consumed = await f.form("/oauth/token", { grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: redirectUri, code_verifier: verifier });
    assert.equal(((await consumed.json()) as Record<string, any>).error, "invalid_grant");

    const second = new URL((await f.approve(client.client_id, verifier)).headers.get("location")!).searchParams.get("code")!;
    const exchanged = await f.form("/oauth/token", { grant_type: "authorization_code", code: second, client_id: client.client_id, redirect_uri: redirectUri, code_verifier: verifier, resource: `${origin}/mcp` });
    assert.equal(exchanged.status, 200);
    const tokens = await exchanged.json() as Record<string, any>;
    assert.equal(tokens.token_type, "Bearer");

    const initialized = await fetch(`${f.base}/mcp`, { method: "POST", headers: { ...mcpHeaders, authorization: `Bearer ${tokens.access_token}` }, body: JSON.stringify(initialize) });
    assert.equal(initialized.status, 200);
    assert.ok(initialized.headers.get("mcp-session-id"));

    const refreshed = await f.form("/oauth/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
    assert.equal(refreshed.status, 200);
    const next = await refreshed.json() as Record<string, any>;
    const stale = await fetch(`${f.base}/mcp`, { method: "POST", headers: { ...mcpHeaders, authorization: `Bearer ${tokens.access_token}` }, body: JSON.stringify(initialize) });
    assert.equal(stale.status, 401);
    assert.match(stale.headers.get("www-authenticate")!, /error="invalid_token"/);

    // Replaying a rotated refresh token revokes the grant.
    assert.equal((await f.form("/oauth/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id })).status, 400);
    assert.equal((await fetch(`${f.base}/mcp`, { method: "POST", headers: { ...mcpHeaders, authorization: `Bearer ${next.access_token}` }, body: JSON.stringify(initialize) })).status, 401);
  } finally { await f.close(); }
});

test("OAuth approval requires the owner's second factor, honours denial and console revocation", async () => {
  const f = await fixture();
  try {
    const client = await f.register({ token_endpoint_auth_method: "client_secret_post" });
    assert.ok(client.client_secret);
    const verifier = randomBytes(32).toString("base64url");

    const query = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: redirectUri, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
    const request = /name="request" value="([^"]+)"/.exec(await (await fetch(`${f.base}/oauth/authorize?${query}`)).text())![1];
    const forged = await f.form("/oauth/authorize", { request, password, code: "000000", decision: "approve" }, { origin: "https://evil.example" });
    assert.equal(forged.status, 403);
    const wrong = await f.form("/oauth/authorize", { request, password, code: "000000", decision: "approve" }, { origin });
    assert.equal(wrong.status, 401);

    const denied = await f.approve(client.client_id, verifier, "deny");
    assert.equal(new URL(denied.headers.get("location")!).searchParams.get("error"), "access_denied");

    const code = new URL((await f.approve(client.client_id, verifier)).headers.get("location")!).searchParams.get("code")!;
    const noSecret = await f.form("/oauth/token", { grant_type: "authorization_code", code, client_id: client.client_id, code_verifier: verifier });
    assert.equal(noSecret.status, 401);
    const code2 = new URL((await f.approve(client.client_id, verifier)).headers.get("location")!).searchParams.get("code")!;
    const tokens = await (await f.form("/oauth/token", { grant_type: "authorization_code", code: code2, client_id: client.client_id, client_secret: client.client_secret, code_verifier: verifier })).json() as Record<string, any>;
    assert.ok(tokens.access_token);

    const listed = await f.consoleCall("oauth");
    assert.deepEqual(listed.data.clients.map((entry: Record<string, unknown>) => entry.name), ["ChatGPT"]);
    // Revocation is a sensitive action: the console re-authenticated at setup within the last 10 minutes.
    assert.equal((await f.consoleCall(`oauth/${client.client_id}`, undefined, "DELETE")).response.status, 200);
    assert.equal((await fetch(`${f.base}/mcp`, { method: "POST", headers: { ...mcpHeaders, authorization: `Bearer ${tokens.access_token}` }, body: JSON.stringify(initialize) })).status, 401);
    assert.equal((await f.consoleCall("oauth")).data.clients.length, 0);
  } finally { await f.close(); }
});

test("OAuth registration rejects unsafe redirect URIs and authorization requires PKCE", async () => {
  const f = await fixture();
  try {
    for (const uris of [["http://example.com/cb"], ["https://example.com/cb#frag"], [], "https://example.com"]) {
      const response = await fetch(`${f.base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: uris }) });
      assert.equal(response.status, 400);
    }
    const client = await f.register();
    const missingPkce = await fetch(`${f.base}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: redirectUri, state: "s" })}`, { redirect: "manual" });
    assert.equal(missingPkce.status, 302);
    assert.equal(new URL(missingPkce.headers.get("location")!).searchParams.get("error"), "invalid_request");
    const foreign = await fetch(`${f.base}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: "https://evil.example/cb" })}`, { redirect: "manual" });
    assert.equal(foreign.status, 400);
  } finally { await f.close(); }
});

test("MCP sessions stay bound to the OAuth client that created them across token refresh", async () => {
  const f = await fixture();
  try {
    const a = await f.register();
    const b = await f.register({ client_name: "Other" });
    const tokensA = await f.grant(a.client_id);
    const tokensB = await f.grant(b.client_id);
    const call = (token: string, body: unknown, sessionId?: string, method = "POST") => fetch(`${f.base}/mcp`, { method,
      headers: { ...mcpHeaders, authorization: `Bearer ${token}`, ...(sessionId ? { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" } : {}) },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}) });
    const sessionId = (await call(tokensA.access_token, initialize)).headers.get("mcp-session-id")!;
    assert.equal((await call(tokensA.access_token, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId)).status, 202);
    const ping = { jsonrpc: "2.0", id: 2, method: "ping" };
    assert.equal((await call(tokensB.access_token, ping, sessionId)).status, 404);
    assert.equal((await call(tokensB.access_token, undefined, sessionId, "DELETE")).status, 404);
    assert.equal((await call("c".repeat(48), ping, sessionId)).status, 404, "the controller token is a different principal");
    assert.equal((await call(tokensA.access_token, ping, sessionId)).status, 200);
    const refreshed = await (await f.form("/oauth/token", { grant_type: "refresh_token", refresh_token: tokensA.refresh_token, client_id: a.client_id })).json() as Record<string, any>;
    assert.equal((await call(refreshed.access_token, ping, sessionId)).status, 200);
  } finally { await f.close(); }
});

test("anonymous OAuth traffic cannot crowd out an approval in progress", async () => {
  const f = await fixture();
  try {
    const client = await f.register();
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: redirectUri,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
    const request = /name="request" value="([^"]+)"/.exec(await (await fetch(`${f.base}/oauth/authorize?${query}`)).text())![1];
    for (let index = 0; index < 300; index++) assert.equal((await fetch(`${f.base}/oauth/authorize?${query}`)).status, 200);
    let limited = 0;
    for (let index = 0; index < 40; index++) {
      const response = await fetch(`${f.base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirectUri] }) });
      if (response.status === 429) limited++;
    }
    assert.ok(limited > 0, "anonymous registration is rate limited per peer");
    assert.equal((await fetch(`${f.base}/oauth/authorize?${query}`)).status, 200, "the in-progress registration survives");
    // Browsers that still send Origin: null are accepted only with Sec-Fetch-Site: same-origin.
    const denied = await f.form("/oauth/authorize", { request, decision: "deny" }, { origin: "null", "sec-fetch-site": "same-origin" });
    assert.equal(new URL(denied.headers.get("location")!).searchParams.get("error"), "access_denied");
    assert.equal((await f.form("/oauth/authorize", { request, decision: "deny" }, { origin: "null" })).status, 403);
    assert.equal((await f.form("/oauth/authorize", { request: `${request.slice(0, -2)}xx`, decision: "deny" }, { origin })).status, 400, "tampered requests are rejected");
    f.advance(11 * 60_000);
    assert.equal((await f.form("/oauth/authorize", { request, decision: "deny" }, { origin })).status, 400, "requests still expire");
  } finally { await f.close(); }
});
