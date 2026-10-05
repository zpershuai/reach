import { createHash, randomUUID } from "node:crypto";
// Contract-test reference implementation. Model B execution and its security
// boundary live in the Rust Engine; the Gateway never imports this module.
import { constants as fsConstants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, relative, resolve, sep } from "node:path";
import {
  type FsEditParams,
  type FsEditResult,
  type FsGlobParams,
  type FsGlobResult,
  type FsGrepParams,
  type FsGrepResult,
  type FsListParams,
  type FsListResult,
  type FsReadParams,
  type FsReadResult,
  type FsStatParams,
  type FsStatResult,
  type FsWriteParams,
  type FsWriteResult,
} from "./index.js";

export const REVISION_CONFLICT = "REVISION_CONFLICT";
export const OLD_STRING_NOT_FOUND = "OLD_STRING_NOT_FOUND";
export const OLD_STRING_NOT_UNIQUE = "OLD_STRING_NOT_UNIQUE";
export const INVALID_CURSOR = "INVALID_CURSOR";
export const WORKSPACE_ACCESS_DENIED = "WORKSPACE_ACCESS_DENIED";
export const MAX_GLOB_RESULTS = 10_000;
export const MAX_GREP_MATCHES = 10_000;
export const MAX_GREP_BYTES = 8 * 1024 * 1024;
export const MAX_GREP_LINE_BYTES = 16 * 1024;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_CURSORS = 32;

export class FilesystemError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

interface CursorSnapshot<T> {
  method: string;
  query: string;
  field: "entries" | "matches";
  items: T[];
  index: number;
  truncated: boolean;
}

export class WorkspaceFilesystem {
  readonly roots: ReadonlyMap<string, string>;
  private readonly cursors = new Map<string, CursorSnapshot<unknown>>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(roots: string | Record<string, string> = { default: resolve(homedir(), ".reach", "workspace") }) {
    this.roots = new Map(Object.entries(typeof roots === "string" ? { default: roots } : roots).map(([name, root]) => [name, resolve(root)]));
  }

  async read(params: FsReadParams): Promise<FsReadResult> {
    const file = await this.resolveEntry(this.rootFor(params.workspace), params.path);
    const stats = await fs.lstat(file);
    if (stats.isDirectory()) throw new FilesystemError("FILE_NOT_FOUND");
    if (!stats.isFile()) throw new FilesystemError(WORKSPACE_ACCESS_DENIED);
    if (stats.size > MAX_FILE_BYTES) throw new FilesystemError("FILE_TOO_LARGE");
    const content = decodeUtf8(await fs.readFile(file));
    const lines = splitLines(content);
    const start = params.startLine - 1;
    const selected = lines.slice(start, start + params.maxLines);
    return {
      content: selected.join("\n"),
      startLine: params.startLine,
      endLine: selected.length === 0 ? params.startLine - 1 : params.startLine + selected.length - 1,
      totalLines: lines.length,
      truncated: start + selected.length < lines.length,
      revision: revision(content),
    };
  }

  async list(params: FsListParams): Promise<FsListResult> {
    const query = stableQuery(params, ["cursor"]);
    const cursor = this.resumeCursor<{ name: string; path: string; type: "file" | "directory" | "symlink" }>("fs.list", query, params.cursor);
    if (cursor) return this.page(cursor, params.maxEntries) as FsListResult;
    const directory = await this.resolveEntry(this.rootFor(params.workspace), params.path);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const items = entries.map((entry) => ({
      name: entry.name,
      path: normalizePath(params.path, entry.name),
      type: entry.isSymbolicLink() ? "symlink" as const : entry.isDirectory() ? "directory" as const : "file" as const,
    })).sort((a, b) => a.path.localeCompare(b.path));
    return this.startPage("fs.list", query, "entries", items, params.maxEntries, false) as FsListResult;
  }

  async stat(params: FsStatParams): Promise<FsStatResult> {
    const entry = await this.resolveEntry(this.rootFor(params.workspace), params.path);
    const stats = await fs.lstat(entry);
    const type = stats.isSymbolicLink() ? "symlink" : stats.isDirectory() ? "directory" : "file";
    const result: FsStatResult = { type, size: stats.size, mtime: stats.mtime.toISOString() };
    if (type === "file") result.revision = revision(await fs.readFile(entry));
    return result;
  }

  async write(params: FsWriteParams): Promise<FsWriteResult> {
    return this.serializeWrite(async () => {
      if (Buffer.byteLength(params.content) > MAX_FILE_BYTES) throw new FilesystemError("FILE_TOO_LARGE");
      const root = this.rootFor(params.workspace);
      const current = await this.readMutationContent(root, params.path);
      if (current !== undefined && Buffer.byteLength(current) > MAX_FILE_BYTES) throw new FilesystemError("FILE_TOO_LARGE");
      if (params.mode === "create" && current !== undefined) throw new FilesystemError("FILE_EXISTS");
      if (params.ifMatch && params.ifMatch !== revision(current ?? "")) throw new FilesystemError(REVISION_CONFLICT);
      await this.atomicWrite(root, params.path, params.content);
      return { path: params.path, bytesWritten: Buffer.byteLength(params.content), revision: revision(params.content) };
    });
  }

  async edit(params: FsEditParams): Promise<FsEditResult> {
    return this.serializeWrite(async () => {
      const root = this.rootFor(params.workspace);
      const current = await this.readMutationContent(root, params.path);
      if (current === undefined) throw new FilesystemError("FILE_NOT_FOUND");
      if (Buffer.byteLength(current) > MAX_FILE_BYTES) throw new FilesystemError("FILE_TOO_LARGE");
      if (params.ifMatch && params.ifMatch !== revision(current)) throw new FilesystemError(REVISION_CONFLICT);
      const occurrences = countOccurrences(current, params.oldString);
      if (occurrences === 0) throw new FilesystemError(OLD_STRING_NOT_FOUND);
      if (occurrences > 1 && !params.replaceAll) throw new FilesystemError(OLD_STRING_NOT_UNIQUE);
      const content = params.replaceAll ? current.split(params.oldString).join(params.newString) : current.replace(params.oldString, params.newString);
      if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new FilesystemError("FILE_TOO_LARGE");
      await this.atomicWrite(root, params.path, content);
      return { path: params.path, replacements: params.replaceAll ? occurrences : 1, revision: revision(content) };
    });
  }

  async glob(params: FsGlobParams): Promise<FsGlobResult> {
    const query = stableQuery(params, ["cursor"]);
    const cursor = this.resumeCursor<string>("fs.glob", query, params.cursor);
    if (cursor) return this.page(cursor, params.maxResults) as FsGlobResult;
    const root = await this.resolveEntry(this.rootFor(params.workspace), params.path);
    const ignored = params.respectGitignore ? await readIgnorePatterns(root) : [];
    const matches: string[] = [];
    let truncated = false;
    for await (const file of walkFileEntries(root, root, ignored)) {
      if (!globMatches(params.pattern, file)) continue;
      if (matches.length === MAX_GLOB_RESULTS) {
        truncated = true;
        break;
      }
      matches.push(file);
    }
    return this.startPage("fs.glob", query, "matches", matches, params.maxResults, truncated) as FsGlobResult;
  }

  async grep(params: FsGrepParams): Promise<FsGrepResult> {
    const query = stableQuery(params, ["cursor"]);
    const cursor = this.resumeCursor<{ path: string; line: number; content: string }>("fs.grep", query, params.cursor);
    if (cursor) return this.page(cursor, params.maxMatches) as FsGrepResult;
    const root = await this.resolveEntry(this.rootFor(params.workspace), params.path);
    let scanned = 0;
    let truncated = false;
    const matches: { path: string; line: number; content: string }[] = [];
    for await (const path of walkFileEntries(root, root, [])) {
      if (params.include.length && !params.include.some((pattern) => globMatches(pattern, path))) continue;
      const absolute = resolve(root, path);
      const stats = await fs.lstat(absolute);
      if (stats.isSymbolicLink()) continue;
      const remaining = MAX_GREP_BYTES - scanned;
      if (remaining <= 0) { truncated = true; break; }
      const scannedData = await readAtMost(absolute, Math.min(stats.size, remaining));
      scanned += scannedData.length;
      if (stats.size > remaining) truncated = true;
      for (const [offset, line] of splitLines(scannedData.toString("utf8")).entries()) {
        if (!line.includes(params.pattern)) continue;
        matches.push({ path, line: offset + 1, content: truncateUtf8(line, MAX_GREP_LINE_BYTES) });
        if (matches.length === MAX_GREP_MATCHES) { truncated = true; break; }
      }
      if (truncated) break;
    }
    return this.startPage("fs.grep", query, "matches", matches, params.maxMatches, truncated) as FsGrepResult;
  }

  close(): void { this.cursors.clear(); }

  private rootFor(workspace: string): string {
    const root = this.roots.get(workspace);
    if (!root) throw new FilesystemError(WORKSPACE_ACCESS_DENIED);
    return root;
  }

  private async resolveEntry(root: string, input: string): Promise<string> {
    const target = await this.resolveChecked(root, input);
    const info = await fs.lstat(target).catch(() => undefined);
    if (!info) throw new FilesystemError("FILE_NOT_FOUND");
    return target;
  }

  private async resolveChecked(configuredRoot: string, input: string): Promise<string> {
    const realRoot = await fs.realpath(configuredRoot).catch(() => configuredRoot);
    const target = resolve(realRoot, input);
    if (target !== realRoot && !target.startsWith(realRoot + sep)) throw new FilesystemError(WORKSPACE_ACCESS_DENIED);
    let current = realRoot;
    for (const part of relative(realRoot, target).split(sep).filter(Boolean)) {
      current = resolve(current, part);
      const info = await fs.lstat(current).catch(() => undefined);
      if (info?.isSymbolicLink()) throw new FilesystemError(WORKSPACE_ACCESS_DENIED);
    }
    return target;
  }

  private async readMutationContent(root: string, input: string): Promise<string | undefined> {
    const { parent, name } = await this.openVerifiedParent(root, input);
    let file: FileHandle | undefined;
    try {
      try {
        file = await fs.open(this.descriptorPath(parent, name), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw new FilesystemError(WORKSPACE_ACCESS_DENIED);
      }
      const stats = await file.stat();
      if (!stats.isFile()) throw new FilesystemError(WORKSPACE_ACCESS_DENIED);
      return decodeUtf8(await file.readFile());
    } finally {
      await file?.close();
      await parent.close();
    }
  }

  private async atomicWrite(root: string, input: string, content: string): Promise<void> {
    const { parent, name } = await this.openVerifiedParent(root, input);
    const temporary = `.${name}.${randomUUID()}.tmp`;
    const temporaryPath = this.descriptorPath(parent, temporary);
    try {
      const file = await fs.open(temporaryPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(content, "utf8"); } finally { await file.close(); }
      await fs.rename(temporaryPath, this.descriptorPath(parent, name));
    } finally {
      await fs.unlink(temporaryPath).catch(() => undefined);
      await parent.close();
    }
  }

  private descriptorPath(directory: FileHandle, name = ""): string {
    if (process.platform !== "linux") throw new FilesystemError(WORKSPACE_ACCESS_DENIED);
    return `/proc/self/fd/${directory.fd}${name ? `/${name}` : ""}`;
  }

  private async openVerifiedParent(root: string, input: string): Promise<{ parent: FileHandle; name: string }> {
    if (process.platform !== "linux" || !fsConstants.O_NOFOLLOW) throw new FilesystemError(WORKSPACE_ACCESS_DENIED);
    const realRoot = await fs.realpath(root).catch(() => { throw new FilesystemError(WORKSPACE_ACCESS_DENIED); });
    const target = resolve(realRoot, input);
    if (target === realRoot || !target.startsWith(realRoot + sep)) throw new FilesystemError(WORKSPACE_ACCESS_DENIED);
    const parts = relative(realRoot, target).split(sep).filter(Boolean);
    const name = parts.pop();
    if (!name) throw new FilesystemError(WORKSPACE_ACCESS_DENIED);
    let parent: FileHandle | undefined;
    try {
      parent = await fs.open(realRoot, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
      for (const part of parts) {
        const childPath = this.descriptorPath(parent, part);
        let child: FileHandle;
        try {
          child = await fs.open(childPath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await fs.mkdir(childPath);
          child = await fs.open(childPath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
        }
        await parent.close();
        parent = child;
      }
      return { parent, name };
    } catch (error) {
      await parent?.close().catch(() => undefined);
      if (error instanceof FilesystemError) throw error;
      throw new FilesystemError(WORKSPACE_ACCESS_DENIED);
    }
  }

  private async serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeQueue;
    let release: () => void = () => {};
    this.writeQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  private resumeCursor<T>(method: string, query: string, cursor?: string): CursorSnapshot<T> | undefined {
    if (!cursor) return undefined;
    const snapshot = this.cursors.get(cursor) as CursorSnapshot<T> | undefined;
    if (!snapshot || snapshot.method !== method || snapshot.query !== query) throw new FilesystemError(INVALID_CURSOR);
    return snapshot;
  }

  private page<T>(snapshot: CursorSnapshot<T>, size: number): { cursor?: string; truncated: boolean; [key: string]: unknown } {
    const values = snapshot.items.slice(snapshot.index, snapshot.index + size);
    snapshot.index += values.length;
    const more = snapshot.index < snapshot.items.length;
    const snapshotId = [...this.cursors.entries()].find(([, item]) => item === snapshot)?.[0];
    const cursor = more ? snapshotId : undefined;
    if (!more && snapshotId) this.cursors.delete(snapshotId);
    const truncated = snapshot.truncated || more;
    return snapshot.field === "entries" ? { entries: values, cursor, truncated } : { matches: values, cursor, truncated };
  }

  private startPage<T>(method: string, query: string, field: "entries" | "matches", items: T[], size: number, truncated: boolean): { cursor?: string; truncated: boolean; [key: string]: unknown } {
    if (this.cursors.size >= MAX_CURSORS) throw new FilesystemError("CURSOR_LIMIT_EXCEEDED");
    const snapshot: CursorSnapshot<T> = { method, query, field, items, index: 0, truncated };
    const cursor = randomUUID();
    this.cursors.set(cursor, snapshot as CursorSnapshot<unknown>);
    return this.page(snapshot, size);
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new FilesystemError("INVALID_UTF8");
  }
}

function revision(content: string | Buffer): string { return createHash("sha256").update(content).digest("hex"); }
function splitLines(content: string): string[] { const lines = content.split(/\r?\n/); if (lines.length > 1 && lines.at(-1) === "") lines.pop(); return lines; }
function countOccurrences(content: string, needle: string): number { if (needle === "") return 0; return content.split(needle).length - 1; }
function stableQuery(params: object, omit: string[]): string { return JSON.stringify(Object.fromEntries(Object.entries(params).filter(([key]) => !omit.includes(key)).sort(([a], [b]) => a.localeCompare(b)))); }
function normalizePath(parent: string, name: string): string { return parent === "." ? name : `${parent.replace(/\/$/, "")}/${name}`; }
function truncateUtf8(value: string, maxBytes: number): string { let bytes = Buffer.from(value); while (bytes.length > maxBytes) bytes = bytes.subarray(0, bytes.length - 1); return bytes.toString("utf8"); }

async function readAtMost(path: string, length: number): Promise<Buffer> { const handle = await fs.open(path, "r"); try { const data = Buffer.alloc(length); const { bytesRead } = await handle.read(data, 0, length, 0); return data.subarray(0, bytesRead); } finally { await handle.close(); } }
async function readIgnorePatterns(root: string): Promise<string[]> { try { return (await fs.readFile(resolve(root, ".gitignore"), "utf8")).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#") && !line.startsWith("!")); } catch { return []; } }
async function* walkFileEntries(root: string, current: string, ignored: string[]): AsyncGenerator<string> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absolute = resolve(current, entry.name);
    const path = relative(root, absolute).split(sep).join("/");
    if (ignored.some((pattern) => gitignoreMatches(pattern, path))) continue;
    if (entry.isDirectory()) yield* walkFileEntries(root, absolute, ignored);
    else if (entry.isFile()) yield path;
  }
}
function gitignoreMatches(pattern: string, path: string): boolean { const normalized = pattern.replace(/^\//, "").replace(/\/$/, ""); return pattern.endsWith("/") ? path === normalized || path.startsWith(`${normalized}/`) : globMatches(normalized.includes("/") ? normalized : `**/${normalized}`, path) || basename(path) === normalized; }
function globMatches(pattern: string, path: string): boolean { const source = pattern.split("**/").map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")).join("(?:.*/)?"); return new RegExp(`^${source}$`).test(path); }
