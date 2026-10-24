import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ClientAccess, ClientAccessError, type AccessChange } from "./client-access.js";
import { ConsoleStore } from "./store.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "reach-client-access-"));
  let now = 1000;
  let store = new ConsoleStore(directory);
  let access = new ClientAccess(store, () => now, () => {});
  return {
    get store() { return store; }, get access() { return access; },
    advance: (ms: number) => { now += ms; },
    reopen: () => { access.close(); store.close(); store = new ConsoleStore(directory); access = new ClientAccess(store, () => now, () => {}); },
    close: () => { access.close(); store.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof ClientAccessError && error.status === 401;
}

const readOnly = [{ engineId: "engine-a", workspace: "docs", read: true, write: false, execute: false }];

test("delegated credentials disclose random tokens once and persist only digests and explicit policy", () => {
  const f = fixture();
  try {
    const issued = f.access.create("Fixture client", 10000, readOnly);
    assert.match(issued.token, /^reach_ct_[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(issued.token.slice("reach_ct_".length), "base64url").length, 32);
    const before = f.access.requireDelegated(`Bearer ${issued.token}`);
    assert.equal(before.principalId, issued.client.id);
    assert.ok(!JSON.stringify(f.access.list()).includes(issued.token));
    assert.ok(!JSON.stringify(f.store.db.prepare("SELECT * FROM client_credentials").all()).includes(issued.token));
    assert.ok(!("credentialDigest" in f.access.get(issued.client.id)));
    f.reopen();
    assert.deepEqual(f.access.requireDelegated(`Bearer ${issued.token}`), before);
    assert.deepEqual(f.access.get(issued.client.id).permissions, readOnly);
    assert.deepEqual(f.access.create("Empty policy", 10000).client.permissions, []);
  } finally { f.close(); }
});

test("rotation and revocation reject old identities immediately without changing another principal", () => {
  const f = fixture();
  try {
    const first = f.access.create("First", 10000);
    const second = f.access.create("Second", 10000);
    const changes: AccessChange[] = [];
    f.access.subscribe(change => changes.push(change));
    const identity = f.access.requireDelegated(`Bearer ${first.token}`);
    const rotated = f.access.rotate(first.client.id, 20000);
    assert.notEqual(rotated.token, first.token);
    assert.equal(rotated.client.policyRevision, 2);
    assert.equal(f.access.valid(identity), false);
    assert.throws(() => f.access.requireDelegated(`Bearer ${first.token}`), isUnauthorized);
    assert.equal(f.access.requireDelegated(`Bearer ${rotated.token}`).principalId, first.client.id);
    f.access.revoke(first.client.id);
    assert.throws(() => f.access.requireDelegated(`Bearer ${rotated.token}`), isUnauthorized);
    assert.equal(f.access.requireDelegated(`Bearer ${second.token}`).principalId, second.client.id);
    assert.equal(f.access.get(second.client.id).policyRevision, 1);
    assert.deepEqual(changes.map(change => change.reason), ["rotation", "revocation"]);
    assert.throws(() => f.access.rotate(first.client.id, 30000), error => error instanceof ClientAccessError && error.status === 409);
  } finally { f.close(); }
});

test("expiry fails closed and sends cleanup notifications once under an injected clock", () => {
  const f = fixture();
  try {
    const issued = f.access.create("Expiring", 2000);
    const identity = f.access.requireDelegated(`Bearer ${issued.token}`);
    const changes: AccessChange[] = [];
    f.access.subscribe(change => changes.push(change));
    f.advance(1000);
    assert.throws(() => f.access.requireDelegated(`Bearer ${issued.token}`), isUnauthorized);
    assert.equal(f.access.valid(identity), false);
    f.access.expire();
    f.access.expire();
    assert.deepEqual(changes, [{ principalId: issued.client.id, reason: "expiry" }]);
    assert.throws(() => f.access.create("Expired", 2000), error => error instanceof ClientAccessError && error.status === 400);
  } finally { f.close(); }
});

test("credential expiry notifies cleanup without waiting for another request", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reach-client-expiry-"));
  const store = new ConsoleStore(directory);
  const access = new ClientAccess(store);
  try {
    const issued = access.create("Expiring fixture", Date.now() + 100);
    const change = await new Promise<AccessChange>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Expiry cleanup was not notified")), 2000);
      access.subscribe(event => { clearTimeout(timeout); resolve(event); });
    });
    assert.deepEqual(change, { principalId: issued.client.id, reason: "expiry" });
    assert.throws(() => access.requireDelegated(`Bearer ${issued.token}`), isUnauthorized);
  } finally { access.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("invalid policy writes are atomic and policy revisions are principal-local", () => {
  const f = fixture();
  try {
    const issued = f.access.create("Fixture", 10000, readOnly);
    const other = f.access.create("Other fixture", 10000);
    const before = f.access.get(issued.client.id);
    assert.throws(() => f.access.setPolicy(issued.client.id, [...readOnly, ...readOnly]));
    assert.deepEqual(f.access.get(issued.client.id), before);
    const count = f.access.list().length;
    assert.throws(() => f.access.create("Invalid policy", 10000, [{ ...readOnly[0], engineId: "*" }]));
    assert.equal(f.access.list().length, count);
    const changed = f.access.setPolicy(issued.client.id, []);
    assert.equal(changed.policyRevision, before.policyRevision + 1);
    assert.deepEqual(changed.permissions, []);
    assert.equal(f.access.get(other.client.id).policyRevision, 1);
    for (const value of [undefined, "Bearer forged", `Bearer ${issued.token} `]) assert.throws(() => f.access.requireDelegated(value), isUnauthorized);
  } finally { f.close(); }
});

test("policy reads are cached and every write, including cascades, invalidates them", () => {
  const f = fixture();
  try {
    const read = { engineId: "engine-a", workspace: "docs", read: true, write: false, execute: false };
    const { client } = f.access.create("Cached", 10_000, [read]);
    const first = f.access.get(client.id);
    assert.equal(f.access.get(client.id), first, "repeated reads reuse the cached policy");
    assert.ok(Object.isFrozen(first) && Object.isFrozen(first.permissions), "cached policies cannot be mutated by callers");
    const widened = f.access.setPolicy(client.id, [{ ...read, write: true }]);
    assert.equal(widened.permissions[0]!.write, true);
    assert.equal(f.access.get(client.id).policyRevision, first.policyRevision + 1);
    // A commit from another connection (a second process or instance) is never served stale.
    const other = new ConsoleStore(f.store.directory); const manager = new ClientAccess(other, () => 1000, () => {});
    try { manager.setPolicy(client.id, [read]); } finally { manager.close(); other.close(); }
    assert.equal(f.access.get(client.id).permissions[0]!.write, false);
    f.access.rotate(client.id, 20_000);
    assert.equal(f.access.get(client.id).policyRevision, first.policyRevision + 3);
    f.access.revoke(client.id);
    assert.notEqual(f.access.get(client.id).revokedAt, null);
    // A row removed by a foreign-key cascade must not linger in the cache once invalidated.
    f.store.db.prepare("INSERT INTO oauth_clients(id,name,redirect_uris,auth_method,secret_digest,created_at) VALUES ('app','App','[]','none',NULL,1)").run();
    f.access.approveOAuth("app", "App", [read]);
    assert.equal(f.access.get("oauth:app").permissions.length, 1);
    f.store.db.prepare("DELETE FROM oauth_clients WHERE id='app'").run();
    f.access.invalidate();
    assert.throws(() => f.access.get("oauth:app"), (error: unknown) => error instanceof ClientAccessError && error.status === 404);
  } finally { f.close(); }
});

test("invalid delegated credentials have a credential-specific code and retain HTTP 401", () => {
  const f = fixture();
  try {
    assert.throws(() => f.access.requireDelegated("Bearer invalid"), {
      status: 401, code: "INVALID_CLIENT_CREDENTIAL", message: "Invalid or expired client credential",
    });
  } finally { f.close(); }
});

test("identity list exposes approval and retained last usage without stale authorization cache metadata", () => {
  const f = fixture();
  try {
    const delegated = f.access.create("Delegated fixture", 10000).client;
    const insert = f.store.db.prepare("INSERT INTO activity(ts,event_type,principal_id) VALUES (?,?,?)");
    insert.run(1500, "rpc.finished", delegated.id);
    insert.run(1800, "admin.action", delegated.id);
    insert.run(1900, "rpc.finished", "other-principal");
    assert.equal(f.access.list()[0].approvedAt, 1000);
    assert.equal(f.access.list()[0].lastUsedAt, 1500);
    insert.run(2000, "rpc.denied", delegated.id);
    assert.equal(f.access.list()[0].lastUsedAt, 2000);
    f.store.db.prepare("INSERT INTO oauth_clients(id,name,redirect_uris,auth_method,created_at,approved_at,last_used_at) VALUES ('fixture-app','ChatGPT','[]','none',500,1200,2500)").run();
    f.access.approveOAuth("fixture-app", "ChatGPT", readOnly);
    const oauth = () => f.access.list().find(client => client.kind === "oauth")!;
    assert.equal(oauth().approvedAt, 1200);
    assert.equal(oauth().lastUsedAt, 2500);
    insert.run(3000, "rpc.finished", "oauth:fixture-app");
    assert.equal(oauth().lastUsedAt, 3000);
    f.store.db.prepare("DELETE FROM activity").run();
    assert.equal(f.access.list().find(client => client.id === delegated.id)!.lastUsedAt, null);
    assert.equal(oauth().lastUsedAt, 2500);
  } finally { f.close(); }
});
