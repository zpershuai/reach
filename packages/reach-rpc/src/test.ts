import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ContractError,
  INVALID_PARAMS,
  parseFsReadRequest,
  parseFsReadResult,
  parseFsEditParams,
  parseFsGlobParams,
  parseFsGrepParams,
  parseFsListParams,
  parseFsStatParams,
  parseFsWriteParams,
  serializeRequest,
  serializeResult,
} from "./index.js";
import {
  FilesystemError,
  OLD_STRING_NOT_FOUND,
  OLD_STRING_NOT_UNIQUE,
  INVALID_CURSOR,
  REVISION_CONFLICT,
  WorkspaceFilesystem,
} from "./workspace.js";

const validRequest = {
  type: "request",
  protocol: "reach-rpc",
  version: "1.0",
  sessionId: "session-1",
  requestId: "request-1",
  method: "fs.read",
  params: { workspace: "repo", path: "README.md" },
};

test("defaults line parameters and serializes camelCase", () => {
  const request = parseFsReadRequest(validRequest);
  assert.equal(request.params.startLine, 1);
  assert.equal(request.params.maxLines, 200);
  assert.deepEqual(JSON.parse(serializeRequest(request)), {
    ...validRequest,
    params: { workspace: "repo", path: "README.md", startLine: 1, maxLines: 200 },
  });
});

test("strips unknown fields", () => {
  const request = parseFsReadRequest({
    ...validRequest,
    future: true,
    params: { ...validRequest.params, future: true },
  });
  assert.equal(serializeRequest(request).includes("future"), false);
});

test("maps invalid data to INVALID_PARAMS", () => {
  assert.throws(
    () => parseFsReadRequest({ ...validRequest, protocol: "jsonrpc" }),
    (error: unknown) => error instanceof ContractError && error.code === INVALID_PARAMS,
  );
  assert.throws(
    () => parseFsReadRequest({ ...validRequest, params: { ...validRequest.params, startLine: 0 } }),
    (error: unknown) => error instanceof ContractError && error.code === INVALID_PARAMS,
  );
});

test("validates read result metadata", () => {
  const result = parseFsReadResult({
    content: "hello",
    startLine: 1,
    endLine: 1,
    totalLines: 1,
    truncated: false,
    revision: "a".repeat(64),
  });
  assert.deepEqual(JSON.parse(serializeResult(result)), result);
});

test("round-trips the shared fixture with normalized defaults", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("../../../fixtures/fs.read.request.json", import.meta.url), "utf8"),
  );
  const normalized = JSON.parse(serializeRequest(parseFsReadRequest(fixture)));
  assert.equal(normalized.params.startLine, 1);
  assert.equal(normalized.params.maxLines, 200);
  assert.equal("futureEnvelope" in normalized, false);
  assert.equal("futureParameter" in normalized.params, false);
  assert.equal("futurePermission" in normalized.permission, false);
});

test("defaults and strips unknown Round 4 filesystem parameters", () => {
  assert.deepEqual(parseFsEditParams({ workspace: "repo", path: "a", oldString: "x", newString: "y", future: true }), {
    workspace: "repo", path: "a", oldString: "x", newString: "y", replaceAll: false,
  });
  assert.deepEqual(parseFsListParams({ workspace: "repo" }), {
    workspace: "repo", path: ".", maxEntries: 200,
  });
  assert.deepEqual(parseFsGlobParams({ workspace: "repo", pattern: "**/*.ts" }), {
    workspace: "repo", pattern: "**/*.ts", path: ".", maxResults: 200, respectGitignore: true,
  });
  assert.deepEqual(parseFsGrepParams({ workspace: "repo", pattern: "needle" }), {
    workspace: "repo", pattern: "needle", path: ".", include: [], maxMatches: 100,
  });
  assert.deepEqual(parseFsStatParams({ workspace: "repo", path: "a", future: true }), {
    workspace: "repo", path: "a",
  });
  assert.deepEqual(parseFsWriteParams({ workspace: "repo", path: "a", content: "x", mode: "create" }), {
    workspace: "repo", path: "a", content: "x", mode: "create",
  });
});

test("rejects invalid Round 4 filesystem parameters", () => {
  for (const input of [
    () => parseFsWriteParams({ workspace: "repo", path: "a", content: "x", mode: "append" }),
    () => parseFsEditParams({ workspace: "repo", path: "a", oldString: "x", newString: "y", replaceAll: "yes" }),
    () => parseFsListParams({ workspace: "repo", maxEntries: 0 }),
    () => parseFsGlobParams({ workspace: "repo", pattern: "x", respectGitignore: "yes" }),
    () => parseFsGrepParams({ workspace: "repo", pattern: "x", maxMatches: 10_001 }),
  ]) {
    assert.throws(input, (error: unknown) => error instanceof ContractError && error.code === INVALID_PARAMS);
  }
});

async function fixtureWorkspace(): Promise<{ root: string; workspace: WorkspaceFilesystem }> {
  const root = await fs.mkdtemp(join(tmpdir(), "reach-round4-"));
  await fs.mkdir(join(root, "nested"));
  await fs.writeFile(join(root, "lines.txt"), "one\ntwo\nthree\n");
  await fs.writeFile(join(root, "edit.txt"), "repeat repeat");
  await fs.writeFile(join(root, "nested", "needle.txt"), "needle\nother\n");
  await fs.writeFile(join(root, ".gitignore"), "*.ignored\n");
  await fs.writeFile(join(root, "hidden.ignored"), "needle");
  return { root, workspace: new WorkspaceFilesystem({ fixture: root }) };
}

test("fixture workspace reads, lists, stats, writes, and edits safely", async () => {
  const { root, workspace } = await fixtureWorkspace();
  try {
    const read = await workspace.read({ workspace: "fixture", path: "lines.txt", startLine: 2, maxLines: 1 });
    assert.deepEqual(read, { content: "two", startLine: 2, endLine: 2, totalLines: 3, truncated: true, revision: read.revision });
    const list = await workspace.list({ workspace: "fixture", path: ".", maxEntries: 2 });
    assert.equal(list.entries.length, 2);
    assert.ok(list.cursor);
    assert.equal((await workspace.list({ workspace: "fixture", path: ".", maxEntries: 2, cursor: list.cursor })).entries.length > 0, true);
    const stat = await workspace.stat({ workspace: "fixture", path: "lines.txt" });
    assert.equal(stat.type, "file");
    assert.equal(stat.revision, read.revision);
    const written = await workspace.write({ workspace: "fixture", path: "new.txt", content: "first", mode: "create" });
    await assert.rejects(
      () => workspace.write({ workspace: "fixture", path: "new.txt", content: "stale", mode: "overwrite", ifMatch: "0".repeat(64) }),
      (error: unknown) => error instanceof FilesystemError && error.code === REVISION_CONFLICT,
    );
    const edited = await workspace.edit({ workspace: "fixture", path: "new.txt", oldString: "first", newString: "second", replaceAll: false, ifMatch: written.revision });
    assert.equal((await fs.readFile(join(root, "new.txt"), "utf8")), "second");
    assert.notEqual(edited.revision, written.revision);
    await assert.rejects(
      () => workspace.edit({ workspace: "fixture", path: "edit.txt", oldString: "repeat", newString: "x", replaceAll: false }),
      (error: unknown) => error instanceof FilesystemError && error.code === OLD_STRING_NOT_UNIQUE,
    );
    await assert.rejects(
      () => workspace.edit({ workspace: "fixture", path: "edit.txt", oldString: "missing", newString: "x", replaceAll: true }),
      (error: unknown) => error instanceof FilesystemError && error.code === OLD_STRING_NOT_FOUND,
    );
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("fixture workspace globs and greps with bounded session cursors", async () => {
  const { root, workspace } = await fixtureWorkspace();
  try {
    const glob = await workspace.glob({ workspace: "fixture", pattern: "**/*.txt", path: ".", maxResults: 1, respectGitignore: true });
    assert.equal(glob.matches.length, 1);
    assert.ok(glob.cursor);
    const next = await workspace.glob({ workspace: "fixture", pattern: "**/*.txt", path: ".", maxResults: 1, respectGitignore: true, cursor: glob.cursor });
    assert.equal(next.matches.length, 1);
    assert.equal((await workspace.glob({ workspace: "fixture", pattern: "**/*", path: ".", maxResults: 20, respectGitignore: true })).matches.includes("hidden.ignored"), false);
    await assert.rejects(
      () => workspace.glob({ workspace: "fixture", pattern: "*.txt", path: ".", maxResults: 1, respectGitignore: true, cursor: glob.cursor }),
      (error: unknown) => error instanceof FilesystemError && error.code === INVALID_CURSOR,
    );
    const grep = await workspace.grep({ workspace: "fixture", pattern: "needle", path: ".", include: ["**/*.txt"], maxMatches: 1 });
    assert.deepEqual(grep.matches, [{ path: "nested/needle.txt", line: 1, content: "needle" }]);
    assert.equal(grep.truncated, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("workspace names, cursor creation, and file operations stay within hard bounds", async () => {
  const { root, workspace } = await fixtureWorkspace();
  try {
    await assert.rejects(
      () => workspace.read({ workspace: "missing", path: "lines.txt", startLine: 1, maxLines: 1 }),
      (error: unknown) => error instanceof FilesystemError && error.code === "WORKSPACE_ACCESS_DENIED",
    );
    const cursors: string[] = [];
    for (let index = 0; index < 32; index += 1) {
      const page = await workspace.list({ workspace: "fixture", path: ".", maxEntries: 1 });
      assert.ok(page.cursor);
      cursors.push(page.cursor);
    }
    await assert.rejects(
      () => workspace.list({ workspace: "fixture", path: ".", maxEntries: 1 }),
      (error: unknown) => error instanceof FilesystemError && error.code === "CURSOR_LIMIT_EXCEEDED",
    );
    await assert.rejects(
      () => workspace.write({ workspace: "fixture", path: "large.txt", content: "x".repeat(8 * 1024 * 1024 + 1), mode: "create" }),
      (error: unknown) => error instanceof FilesystemError && error.code === "FILE_TOO_LARGE",
    );
    await fs.writeFile(join(root, "too-large.txt"), "x".repeat(8 * 1024 * 1024 + 1));
    await assert.rejects(
      () => workspace.read({ workspace: "fixture", path: "too-large.txt", startLine: 1, maxLines: 1 }),
      (error: unknown) => error instanceof FilesystemError && error.code === "FILE_TOO_LARGE",
    );
    // Keep snapshots live until the limit assertion above, then close them together.
    assert.equal(cursors.length, 32);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
