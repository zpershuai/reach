import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AccountCredentials, base32, normalizeUsername, hashPassword, newTotpSecret, totp, verifyPassword, verifyTotp } from "./credentials.js";
import { ConsoleStore } from "./store.js";

test("TOTP matches every RFC 6238 Appendix B SHA1 vector, including dates beyond 2038", () => {
  const secret = base32(Buffer.from("12345678901234567890"));
  for (const [seconds, expected] of [
    [59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"],
    [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"],
  ] as const) {
    assert.equal(totp(secret, seconds * 1000, 8), expected);
    assert.equal(totp(secret, seconds * 1000), expected.slice(-6));
  }
  const now = 1234567890 * 1000;
  assert.equal(verifyTotp(secret, totp(secret, now - 30_000), -1, now), Math.floor(now / 30_000) - 1);
  assert.equal(verifyTotp(secret, totp(secret, now + 30_000), -1, now), Math.floor(now / 30_000) + 1);
  assert.equal(verifyTotp(secret, totp(secret, now - 90_000), -1, now), undefined);
  assert.match(newTotpSecret(), /^[A-Z2-7]{32}$/);
});

test("scrypt uses independent salts, verifies passwords and rejects malformed hashes", async () => {
  const first = await hashPassword("a long test password");
  const second = await hashPassword("a long test password");
  assert.notEqual(first, second);
  assert.equal(await verifyPassword("a long test password", first), true);
  assert.equal(await verifyPassword("wrong password", first), false);
  assert.equal(await verifyPassword("anything", "scrypt$invalid"), false);
});

test("second factors are per user: replay state and hashed single-use recovery codes do not cross accounts", () => {
  const directory = mkdtempSync(join(tmpdir(), "reach-credentials-"));
  let store = new ConsoleStore(directory);
  try {
    const secret = newTotpSecret();
    const other = newTotpSecret();
    const now = Date.now();
    const insert = store.db.prepare("INSERT INTO users(id,username,username_key,password_hash,role,totp_secret,created_at,password_changed_at) VALUES (?,?,?,?,?,?,?,?)");
    insert.run(1, "admin", "admin", "test-hash", "admin", secret, now, now);
    insert.run(2, "ops", "ops", "test-hash", "user", other, now, now);
    insert.run(3, "plain", "plain", "test-hash", "user", null, now, now);
    let credentials = new AccountCredentials(store);
    const code = totp(secret, now);
    assert.equal(credentials.acceptFactor(2, code, now), code === totp(other, now));
    assert.equal(credentials.acceptFactor(1, code, now), true);
    assert.equal(credentials.acceptFactor(1, code, now), false);
    assert.equal(credentials.acceptFactor(2, totp(other, now), now), true, "user 1's replay step does not block user 2");
    assert.equal(credentials.acceptFactor(3, code, now), false, "an account without TOTP has no second factor");
    const recovery = credentials.replaceRecoveryCodes(1);
    assert.equal(recovery.length, 10);
    assert.ok(recovery.every(value => /^[A-Z2-7]{10}$/.test(value)));
    assert.ok(recovery.every(value => !JSON.stringify(store.db.prepare("SELECT * FROM recovery_codes").all()).includes(value)));
    assert.equal(credentials.acceptFactor(2, recovery[0], now), false, "another user's recovery code is rejected");
    assert.equal(credentials.acceptFactor(1, recovery[0], now), true);
    assert.equal(credentials.acceptFactor(1, recovery[0], now), false);
    store.close();
    store = new ConsoleStore(directory);
    credentials = new AccountCredentials(store);
    assert.equal(credentials.acceptFactor(1, code, now), false);
    assert.equal(credentials.acceptFactor(1, recovery[1], now), true);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("usernames are 3-64 safe characters", () => {
  for (const valid of ["abc", "Alice.Ops_01-x", "a".repeat(64), "  ops  "]) assert.ok(normalizeUsername(valid));
  assert.equal(normalizeUsername("  ops  "), "ops");
  for (const invalid of ["ab", "a".repeat(65), "has space", "名字", "x/y", "", 7, undefined]) assert.equal(normalizeUsername(invalid), undefined);
});
