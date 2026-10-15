import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdminCredentials, base32, hashPassword, newTotpSecret, totp, verifyPassword, verifyTotp } from "./credentials.js";
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

test("second factors persist replay protection and consume hashed single-use recovery codes", () => {
  const directory = mkdtempSync(join(tmpdir(), "reach-credentials-"));
  let store = new ConsoleStore(directory);
  try {
    const secret = newTotpSecret();
    const now = Date.now();
    store.db.prepare("INSERT INTO admin(id,password_hash,totp_secret,created_at) VALUES (1,?,?,?)").run("test-hash", secret, now);
    let credentials = new AdminCredentials(store);
    const code = totp(secret, now);
    assert.equal(credentials.acceptFactor(code, now), true);
    assert.equal(credentials.acceptFactor(code, now), false);
    const recovery = credentials.issueRecoveryCodes();
    assert.equal(recovery.length, 10);
    assert.ok(recovery.every(value => /^[A-Z2-7]{10}$/.test(value)));
    assert.ok(recovery.every(value => !JSON.stringify(store.db.prepare("SELECT * FROM recovery_codes").all()).includes(value)));
    assert.equal(credentials.acceptFactor(recovery[0], now), true);
    assert.equal(credentials.acceptFactor(recovery[0], now), false);
    store.close();
    store = new ConsoleStore(directory);
    credentials = new AdminCredentials(store);
    assert.equal(credentials.acceptFactor(code, now), false);
    assert.equal(credentials.acceptFactor(recovery[0], now), false);
    assert.equal(credentials.acceptFactor(recovery[1], now), true);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
