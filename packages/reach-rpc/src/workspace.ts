import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, relative, resolve, sep } from "node:path";
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
  readonly root: string;
  private readonly cursors = new Map<string, CursorSnapshot<unknown>>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(root = resolve(homedir(), ".reach", "workspace")) {
    this.root = resolve(root);
  }

  async read(params: FsReadParams): Promise<FsReadResult> {
    const file = await this.resolveEntry(params.path);
    const content = await fs.readFile(file, "utf8");
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
    const directory = await this.resolveEntry(params.path);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const items = entries.map((entry) => ({
      name: entry.name,
      path: normalizePath(params.path, entry.name),
      type: entry.isSymbolicLink() ? "symlink" as const : entry.isDirectory() ? "directory" as const : "file" as const,
    })).sort((a, b) => a.path.localeCompare(b.path));
    return this.startPage("fs.list", query, "entries", items, params.maxEntries, false) as FsListResult;
  }

  async stat(params: FsStatParams): Promise<FsStatResult> {
    const entry = await this.resolveEntry(params.path);
    const stats = await fs.lstat(entry);
    const type = stats.isSymbolicLink() ? "symlink" : stats.isDirectory() ? "directory" : "file";
    const result: FsStatResult = { type, size: stats.size, mtime: stats.mtime.toISOString() };
    if (type === "file") result.revision = revision(await fs.readFile(entry));
    return result;
  }

  async write(params: FsWriteParams): Promise<FsWriteResult> {
    return this.serializeWrite(async () => {
      const file = await this.resolveMutationPath(params.path);
      const current = await fileContentIfExists(file);
      if (params.mode === "create" && current !== undefined) throw new FilesystemError("FILE_EXISTS");
      if (params.ifMatch && params.ifMatch !== revision(current ?? "")) throw new FilesystemError(REVISION_CONFLICT);
      await this.atomicWrite(file, params.content);
      return { path: params.path, bytesWritten: Buffer.byteLength(params.content), revision: revision(params.content) };
    });
  }

  async edit(params: FsEditParams): Promise<FsEditResult> {
    return this.serializeWrite(async () => {
      const file = await this.resolveMutationPath(params.path);
      const current = await fileContentIfExists(file);
      if (current === undefined) throw new FilesystemError("FILE_NOT_FOUND");
      if (params.ifMatch && params.ifMatch !== revision(current)) throw new FilesystemError(REVISION_CONFLICT);
      const occurrences = countOccurrences(current, params.oldString);
      if (occurrences === 0) throw new FilesystemError(OLD_STRING_NOT_FOUND);
      if (occurrences > 1 && !params.replaceAll) throw new FilesystemError(OLD_STRING_NOT_UNIQUE);
      const content = params.replaceAll ? current.split(params.oldString).join(params.newString) : current.replace(params.oldString, params.newString);
      await this.atomicWrite(file, content);
      return { path: params.path, replacements: params.replaceAll ? occurrences : 1, revision: revision(content) };
    });
  }

  async glob(params: FsGlobParams): Promise<FsGlobResult> {
    const query = stableQuery(params, ["cursor"]);
    const cursor = this.resumeCursor<string>("fs.glob", query, params.cursor);
    if (cursor) return this.page(cursor, params.maxResults) as FsGlobResult;
    const root = await this.resolveEntry(params.path);
    const ignored = params.respectGitignore ? await readIgnorePatterns(root) : [];
    const files = await walkFiles(root, root, ignored, MAX_GLOB_RESULTS);
    const matches = files.filter((file) => globMatches(params.pattern, file));
    return this.startPage("fs.glob", query, "matches", matches.slice(0, MAX_GLOB_RESULTS), params.maxResults, matches.length > MAX_GLOB_RESULTS) as FsGlobResult;
  }

  async grep(params: FsGrepParams): Promise<FsGrepResult> {
    const query = stableQuery(params, ["cursor"]);
    const cursor = this.resumeCursor<{ path: string; line: number; content: string }>("fs.grep", query, params.cursor);
    if (cursor) return this.page(cursor, params.maxMatches) as FsGrepResult;
    const root = await this.resolveEntry(params.path);
    const files = await walkFiles(root, root, [], MAX_GLOB_RESULTS);
    let scanned = 0;
    let truncated = false;
    const matches: { path: string; line: number; content: string }[] = [];
    let expression: RegExp;
    try { expression = new RegExp(params.pattern); } catch { throw new FilesystemError("INVALID_PARAMS"); }
    for (const path of files) {
      if (params.include.length && !params.include.some((pattern) => globMatches(pattern, path))) continue;
      const absolute = resolve(root, path);
      const stats = await fs.lstat(absolute);
      if (stats.isSymbolicLink()) continue;
      const remaining = MAX_GREP_BYTES - scanned;
      if (remaining <= 0) { truncated = true; break; }
      const data = await fs.readFile(absolute);
      const scannedData = data.subarray(0, remaining);
      scanned += scannedData.length;
      if (data.length > remaining) truncated = true;
      for (const [offset, line] of splitLines(scannedData.toString("utf8")).entries()) {
        expression.lastIndex = 0;
        if (!expression.test(line)) continue;
        matches.push({ path, line: offset + 1, content: truncateUtf8(line, MAX_GREP_LINE_BYTES) });
        if (matches.length === MAX_GREP_MATCHES) { truncated = true; break; }
      }
      if (truncated) break;
    }
    return this.startPage("fs.grep", query, "matches", matches, params.maxMatches, truncated) as FsGrepResult;
  }

  close(): void { this.cursors.clear(); }

  private async resolveEntry(input: string): Promise<string> {
    const target = await this.resolveChecked(input);
    const info = await fs.lstat(target).catch(() => undefined);
    if (!info) throw new FilesystemError("FILE_NOT_FOUND");
    return target;
  }

  private async resolveMutationPath(input: string): Promise<string> {
    const target = await this.resolveChecked(input);
    const info = await fs.lstat(target).catch(() => undefined);
    if (info?.isSymbolicLink()) throw new FilesystemError(WORKSPACE_ACCESS_DENIED);
    await fs.mkdir(dirname(target), { recursive: true });
    return target;
  }

  private async resolveChecked(input: string): Promise<string> {
    const root = await fs.realpath(this.root).catch(() => this.root);
    const target = resolve(root, input);
    if (target !== root && !target.startsWith(root + sep)) throw new FilesystemError(WORKSPACE_ACCESS_DENIED);
    let current = root;
    for (const part of relative(root, target).split(sep).filter(Boolean)) {
      current = resolve(current, part);
      const info = await fs.lstat(current).catch(() => undefined);
      if (info?.isSymbolicLink()) throw new FilesystemError(WORKSPACE_ACCESS_DENIED);
    }
    return target;
  }

  private async atomicWrite(file: string, content: string): Promise<void> {
    const temporary = resolve(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
    try { await fs.writeFile(temporary, content, { flag: "wx" }); await fs.rename(temporary, file); }
    finally { await fs.unlink(temporary).catch(() => undefined); }
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
    const cursor = more ? [...this.cursors.entries()].find(([, item]) => item === snapshot)?.[0] : undefined;
    if (!more && cursor) this.cursors.delete(cursor);
    const truncated = snapshot.truncated || more;
    return snapshot.field === "entries" ? { entries: values, cursor, truncated } : { matches: values, cursor, truncated };
  }

  private startPage<T>(method: string, query: string, field: "entries" | "matches", items: T[], size: number, truncated: boolean): { cursor?: string; truncated: boolean; [key: string]: unknown } {
    const snapshot: CursorSnapshot<T> = { method, query, field, items, index: 0, truncated };
    const cursor = randomUUID();
    this.cursors.set(cursor, snapshot as CursorSnapshot<unknown>);
    return this.page(snapshot, size);
  }
}

function revision(content: string | Buffer): string { return createHash("sha256").update(content).digest("hex"); }
function splitLines(content: string): string[] { const lines = content.split(/\r?\n/); if (lines.length > 1 && lines.at(-1) === "") lines.pop(); return lines; }
function countOccurrences(content: string, needle: string): number { if (needle === "") return 0; return content.split(needle).length - 1; }
function stableQuery(params: object, omit: string[]): string { return JSON.stringify(Object.fromEntries(Object.entries(params).filter(([key]) => !omit.includes(key)).sort(([a], [b]) => a.localeCompare(b)))); }
function normalizePath(parent: string, name: string): string { return parent === "." ? name : `${parent.replace(/\/$/, "")}/${name}`; }
function truncateUtf8(value: string, maxBytes: number): string { const bytes = Buffer.from(value); return bytes.length <= maxBytes ? value : bytes.subarray(0, maxBytes).toString("utf8"); }

async function fileContentIfExists(file: string): Promise<string | undefined> { try { return await fs.readFile(file, "utf8"); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
async function readIgnorePatterns(root: string): Promise<string[]> { try { return (await fs.readFile(resolve(root, ".gitignore"), "utf8")).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#") && !line.startsWith("!")); } catch { return []; } }
async function walkFiles(root: string, current: string, ignored: string[], limit: number): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (files.length >= limit) return;
      if (entry.isSymbolicLink()) continue;
      const absolute = resolve(directory, entry.name); const path = relative(root, absolute).split(sep).join("/");
      if (ignored.some((pattern) => gitignoreMatches(pattern, path))) continue;
      if (entry.isDirectory()) await visit(absolute); else if (entry.isFile()) files.push(path);
    }
  }
  await visit(current); return files.sort();
}
function gitignoreMatches(pattern: string, path: string): boolean { const normalized = pattern.replace(/^\//, "").replace(/\/$/, ""); return pattern.endsWith("/") ? path === normalized || path.startsWith(`${normalized}/`) : globMatches(normalized.includes("/") ? normalized : `**/${normalized}`, path) || basename(path) === normalized; }
function globMatches(pattern: string, path: string): boolean { const source = pattern.split("**/").map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")).join("(?:.*/)?"); return new RegExp(`^${source}$`).test(path); }
