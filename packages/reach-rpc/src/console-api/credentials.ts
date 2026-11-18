import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { ConsoleStore } from "./store.js";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { bits -= 5; output += alphabet[(value >>> bits) & 31]; }
    value &= (1 << bits) - 1;
  }
  if (bits) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(secret: string): Buffer {
  if (!/^[A-Z2-7]+$/.test(secret)) throw new Error("Invalid TOTP secret");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of secret) {
    value = (value << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(bytes);
}

function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derivePassword(password, salt);
  return `scrypt$32768$8$1$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const match = /^scrypt\$32768\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(encoded);
  if (!match) return false;
  const actual = await derivePassword(password, Buffer.from(match[1], "hex"));
  return timingSafeEqual(actual, Buffer.from(match[2], "hex"));
}

export function newTotpSecret(): string { return base32(randomBytes(20)); }

/** RFC 6238 HMAC-SHA1; `timeMs` is Unix time in milliseconds. */
export function totp(secret: string, timeMs: number, digits: 6 | 8 = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timeMs / 30_000)));
  const digest = createHmac("sha1", decodeBase32(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  const value = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(value % (10 ** digits)).padStart(digits, "0");
}

export function verifyTotp(secret: string, code: string, lastStep: number, timeMs: number): number | undefined {
  if (!/^\d{6}$/.test(code)) return undefined;
  const current = Math.floor(timeMs / 30_000);
  for (const step of [current, current - 1, current + 1]) {
    if (step < 0 || step <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(code), Buffer.from(totp(secret, step * 30_000)))) return step;
  }
  return undefined;
}

export function credentialDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export type UserRole = "admin" | "user";
export const userRoles: readonly UserRole[] = ["admin", "user"];

/** Returns the display username, or undefined when it is not 3-64 of `[A-Za-z0-9._-]`. */
export function normalizeUsername(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const username = value.trim();
  return /^[A-Za-z0-9._-]{3,64}$/.test(username) ? username : undefined;
}

export function usernameKey(username: string): string { return username.toLowerCase(); }

export function validPassword(value: unknown): value is string {
  return typeof value === "string" && value.length >= 12 && value.length <= 1024;
}

/** Per-user second factors: TOTP replay state and hashed single-use recovery codes. */
export class AccountCredentials {
  constructor(private readonly store: ConsoleStore) {}

  /** Replaces the user's recovery codes; call inside a transaction when combined with other writes. */
  replaceRecoveryCodes(userId: number): string[] {
    const codes = new Set<string>();
    while (codes.size < 10) codes.add(base32(randomBytes(7)).slice(0, 10));
    this.store.db.prepare("DELETE FROM recovery_codes WHERE user_id=?").run(userId);
    const insert = this.store.db.prepare("INSERT INTO recovery_codes(digest,user_id) VALUES (?,?)");
    for (const code of codes) insert.run(credentialDigest(code), userId);
    return [...codes];
  }

  /** Call only after verifying the password. Updates replay state atomically. */
  acceptFactor(userId: number, code: string, timeMs: number): boolean {
    const user = this.store.db.prepare("SELECT totp_secret,last_totp_step FROM users WHERE id=?").get(userId);
    if (!user || user.totp_secret === null) return false;
    if (/^[A-Z2-7]{10}$/.test(code)) {
      return this.store.db.prepare("DELETE FROM recovery_codes WHERE digest=? AND user_id=?").run(credentialDigest(code), userId).changes === 1;
    }
    const step = verifyTotp(String(user.totp_secret), code, Number(user.last_totp_step), timeMs);
    if (step === undefined) return false;
    return this.store.db.prepare("UPDATE users SET last_totp_step=? WHERE id=? AND last_totp_step < ?").run(step, userId, step).changes === 1;
  }
}
