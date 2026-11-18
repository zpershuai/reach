import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConsoleAuth } from "./auth.js";
import { hashPassword, newTotpSecret, totp } from "./credentials.js";
import { GatewayEvents } from "./events.js";
import { ConsoleStore } from "./store.js";

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "reach-account-races-"));
  const store = new ConsoleStore(directory);
  const auth = new ConsoleAuth(store, { dataDir: directory, publicOrigin: "https://gateway.example.com", setupToken: "fixture-token", trustedProxies: [], retentionDays: 30 },
    new GatewayEvents(), Date.now, () => {});
  const admin = auth.users.create("owner", await hashPassword("the owner password"), "admin");
  return { store, auth, admin, close: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("a password reset, disable or demotion while the password is being checked defeats that attempt", async () => {
  const f = await fixture();
  try {
    const viewer = f.auth.users.create("viewer", await hashPassword("the viewer password"), "admin");
    const replacement = await hashPassword("a replacement password");
    // verifyAccount reads the account synchronously, then awaits scrypt; change the account in between.
    let attempt = f.auth.verifyAccount("peer-a", "/test", "owner", "the owner password", undefined);
    f.auth.users.setPassword(f.admin.id, replacement);
    assert.equal((await attempt).status, "fail", "the old password no longer opens the account after a reset");

    attempt = f.auth.verifyAccount("peer-b", "/test", "viewer", "the viewer password", undefined);
    f.auth.users.update(viewer.id, { disabled: true });
    assert.equal((await attempt).status, "fail", "an account disabled mid-check is refused");
    f.auth.users.update(viewer.id, { disabled: false });

    attempt = f.auth.verifyAccount("peer-c", "/test", "viewer", "the viewer password", undefined, { role: "admin" });
    f.auth.users.update(viewer.id, { role: "user" });
    assert.equal((await attempt).status, "fail", "a demotion mid-check removes approval authority");

    attempt = f.auth.verifyAccount("peer-d", "/test", "viewer", "the viewer password", undefined);
    const enabled = f.auth.users.enableTotp(viewer.id, newTotpSecret(), 1);
    assert.equal(enabled.length, 10);
    assert.equal((await attempt).status, "totp_required", "TOTP enabled mid-check is enforced");
  } finally { f.close(); }
});

test("a role requirement is checked before any second factor is asked for or consumed", async () => {
  const f = await fixture();
  try {
    const viewer = f.auth.users.create("viewer", await hashPassword("the viewer password"), "user");
    const codes = f.auth.users.enableTotp(viewer.id, newTotpSecret(), 1);
    assert.equal((await f.auth.verifyAccount("peer", "/oauth/authorize", "viewer", "the viewer password", undefined, { role: "admin" })).status, "fail",
      "no TOTP prompt for an account that cannot approve");
    assert.equal((await f.auth.verifyAccount("peer", "/oauth/authorize", "viewer", "the viewer password", codes[0], { role: "admin" })).status, "fail");
    assert.equal((await f.auth.verifyAccount("peer2", "/login", "viewer", "the viewer password", codes[0])).status, "ok",
      "the recovery code was not consumed by the refused approval");
  } finally { f.close(); }
});

test("account ids are never reused after deletion", async () => {
  const f = await fixture();
  try {
    const first = f.auth.users.create("first", await hashPassword("first account pw"), "user");
    f.auth.users.delete(first.id);
    const second = f.auth.users.create("second", await hashPassword("second account pw"), "user");
    assert.ok(second.id > first.id, `id ${second.id} must not reuse ${first.id}`);
  } finally { f.close(); }
});

test("a pending TOTP enrolment is consumed once; a stale or concurrent confirmation cannot overwrite it", async () => {
  const f = await fixture();
  try {
    const now = Date.now();
    f.store.db.prepare("INSERT INTO console_sessions (digest,user_id,csrf_token,created_at,last_seen_at,reauthenticated_at) VALUES ('s1',?,?,?,?,?)").run(f.admin.id, "c", now, now, now);
    const secret = newTotpSecret();
    f.store.db.prepare("UPDATE console_sessions SET pending_totp_secret=?, pending_totp_expires_at=? WHERE digest='s1'").run(secret, now + 60_000);
    const step = Math.floor(now / 30_000);
    assert.equal(totp(secret, now).length, 6);
    const codes = f.auth.users.enableTotp(f.admin.id, secret, step, "s1");
    assert.equal(codes.length, 10);
    assert.throws(() => f.auth.users.enableTotp(f.admin.id, secret, step, "s1"), { code: "TOTP_ENROLMENT_STALE" });
    // A newer enrolment started elsewhere cannot replace the enabled secret or its recovery codes.
    const other = newTotpSecret();
    f.store.db.prepare("UPDATE console_sessions SET pending_totp_secret=?, pending_totp_expires_at=? WHERE digest='s1'").run(other, now + 60_000);
    assert.throws(() => f.auth.users.enableTotp(f.admin.id, other, step, "s1"), { code: "TOTP_ALREADY_ENABLED" });
    assert.equal(f.store.db.prepare("SELECT totp_secret FROM users WHERE id=?").get(f.admin.id)!.totp_secret, secret);
    assert.ok(f.auth.users.credentials.acceptFactor(f.admin.id, codes[0], now), "the first recovery codes still work");
  } finally { f.close(); }
});
