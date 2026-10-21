import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { ConfigurationError } from "../diagnostics.js";

const filename = "admin-setup-token";

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * The credential file itself must be ours, 0600 and not a link; that is what stops tampering.
 * The directory only has to rule out strangers swapping entries, so group-writable volumes
 * (Kubernetes fsGroup, bind mounts owned by another uid) remain usable.
 */
function checkDirectory(directory: string): void {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || ((stat.mode & 0o002) !== 0 && (stat.mode & 0o1000) === 0)) throw new ConfigurationError("Unsafe console setup credential directory: it must not be a link or world-writable");
}

function readToken(path: string): { token: string; dev: number; ino: number } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size !== 49) throw new ConfigurationError("Unsafe console setup credential file");
    const text = readFileSync(fd, "utf8");
    if (!/^[a-f0-9]{48}\n$/.test(text)) throw new ConfigurationError("Invalid console setup credential file");
    return { token: text.slice(0, -1), dev: stat.dev, ino: stat.ino };
  } finally { closeSync(fd); }
}

/** Publish a complete private file without ever overwriting an existing credential. */
export function loadSetupToken(directory: string): string {
  checkDirectory(directory);
  const path = join(directory, filename);
  try { return readToken(path).token; } catch (error) { if (!missing(error)) throw new ConfigurationError("Cannot safely read console setup credential"); }
  const temporary = join(directory, `.${filename}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try {
      writeFileSync(fd, `${randomBytes(24).toString("hex")}\n`);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    try { linkSync(temporary, path); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
  } finally { unlinkSync(temporary); }
  try { return readToken(path).token; }
  catch { throw new ConfigurationError("Cannot safely read console setup credential"); }
}

/**
 * Best effort once an administrator exists: a leftover file can no longer be used, so failing
 * to remove it must not block startup or a completed setup. Never follows a substituted link or
 * removes a different file. Returns false when the file remains.
 */
export function removeSetupToken(directory: string): boolean {
  const path = join(directory, filename);
  try {
    lstatSync(path);
    checkDirectory(directory);
    const opened = readToken(path);
    const current = lstatSync(path);
    if (!current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino) throw new ConfigurationError("Console setup credential changed during removal");
    unlinkSync(path);
    return true;
  } catch (error) { return missing(error); }
}
