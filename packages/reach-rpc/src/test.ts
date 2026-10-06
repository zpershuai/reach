import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GATEWAY_VERSION } from "./version.js";
import { GrantStore, GRANT_TTL_MS } from "./grants.js";
import {
  ContractError,
  INVALID_PARAMS,
  parseFsReadRequest,
  parseFsReadResult,
  parseRequestEnvelope,
  parseFsEditParams,
  parseFsGlobParams,
  parseFsGrepParams,
  parseFsListParams,
  parseFsStatParams,
  parseFsWriteParams,
  parseSessionMessage,
  serializeRequest,
  serializeResult,
  serializeSessionMessage,
  type SessionReady,
  PROTOCOL,
  VERSION,
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

test("shared absolute deadline survives typed and generic parsing", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../../fixtures/fs.read.deadline.request.json", import.meta.url), "utf8"));
  assert.equal(parseRequestEnvelope(fixture).deadlineAt, fixture.deadlineAt);
  assert.equal(JSON.parse(serializeRequest(parseFsReadRequest(fixture))).deadlineAt, fixture.deadlineAt);
  for (const deadlineAt of [null, "not-a-time", 123]) {
    assert.throws(() => parseRequestEnvelope({ ...fixture, deadlineAt }), ContractError);
    assert.throws(() => parseFsReadRequest({ ...fixture, deadlineAt }), ContractError);
  }
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

test("parses the shared session control fixtures", () => {
  const ready = parseSessionMessage(JSON.parse(
    readFileSync(new URL("../../../fixtures/session.ready.json", import.meta.url), "utf8"),
  ));
  assert.equal(ready.type, "session.ready");
  assert.equal("engineId" in ready && ready.engineId, "reach-engine");
  assert.ok(Array.isArray("methods" in ready && ready.methods) && ready.methods.includes("fs.read"));
  // Unknown fields are stripped, matching the data-plane contract.
  assert.equal("futureField" in ready, false);

  const renew = parseSessionMessage(JSON.parse(
    readFileSync(new URL("../../../fixtures/session.renew.json", import.meta.url), "utf8"),
  ));
  assert.equal(renew.type, "session.renew");
  assert.equal("leaseExpiresAt" in renew && renew.leaseExpiresAt, "2026-09-03T12:00:00Z");

  const close = parseSessionMessage(JSON.parse(
    readFileSync(new URL("../../../fixtures/session.close.json", import.meta.url), "utf8"),
  ));
  assert.equal(close.type, "session.close");
  assert.equal("reason" in close && close.reason, "agent_requested");

  const closed = parseSessionMessage(JSON.parse(
    readFileSync(new URL("../../../fixtures/session.closed.json", import.meta.url), "utf8"),
  ));
  assert.equal(closed.type, "session.closed");
  assert.equal("reason" in closed && closed.reason, "lease_expired");
});

test("rejects malformed session control messages", () => {
  const throws = (input: unknown) => assert.throws(
    () => parseSessionMessage(input),
    (error: unknown) => error instanceof ContractError && error.code === INVALID_PARAMS,
  );
  throws({ type: "session.renew", sessionId: "s", leaseExpiresAt: "yesterday" });
  throws({ type: "session.renew", sessionId: "s" });
  throws({ type: "session.close", sessionId: "s", reason: "" });
  throws({ type: "session.closed", sessionId: "s", reason: "" });
  throws({ type: "session.frobnicate", sessionId: "s" });
  throws({ type: "request", protocol: "reach-rpc", version: "1.0", sessionId: "s", requestId: "r", method: "fs.read", params: {} });
});

test("Gateway CLI reports its package version before validating startup configuration", () => {
  const output = execFileSync(process.execPath, [fileURLToPath(new URL("./gateway-main.js", import.meta.url)), "--version"], {
    env: { ...process.env, GATEWAY_PORT: "invalid" }, encoding: "utf8", timeout: 5000,
  });
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(output.trim(), manifest.version);
  assert.equal(GATEWAY_VERSION, manifest.version);
});

test("session control messages round-trip with a discriminated type", () => {
  const ready: SessionReady = {
    type: "session.ready",
    protocol: PROTOCOL,
    version: VERSION,
    sessionId: "s",
    engineId: "engine",
    engineVersion: "2.3.4",
    workspaces: ["default"],
    methods: ["fs.read"],
  };
  const text = serializeSessionMessage(ready);
  assert.ok(text.includes('"type":"session.ready"'));
  assert.ok(text.includes('"sessionId":"s"'));
  const parsed = parseSessionMessage(JSON.parse(text));
  assert.equal(parsed.type, "session.ready");
  assert.equal("engineVersion" in parsed && parsed.engineVersion, "2.3.4");
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
    // Descriptor-relative mutations in the TypeScript reference require Linux.
    // Model B executes writes on the Rust Engine, which is covered separately.
    if (process.platform === "linux") {
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
    }
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

test("completed pages release snapshots and invalidate exhausted cursors", async () => {
  const { root, workspace } = await fixtureWorkspace();
  try {
    for (let index = 0; index < 40; index += 1) {
      await workspace.list({ workspace: "fixture", path: ".", maxEntries: 100 });
      let page = await workspace.list({ workspace: "fixture", path: ".", maxEntries: 1 });
      const exhausted = page.cursor;
      while (page.cursor) page = await workspace.list({ workspace: "fixture", path: ".", maxEntries: 1, cursor: page.cursor });
      assert.equal(page.cursor, undefined);
      await assert.rejects(() => workspace.list({ workspace: "fixture", path: ".", maxEntries: 1, cursor: exhausted }), (cause: unknown) => cause instanceof FilesystemError && cause.code === INVALID_CURSOR);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("grep treats patterns literally and bounds incremental work and output", async () => {
  const { root, workspace } = await fixtureWorkspace();
  try {
    await fs.writeFile(join(root, "literal.txt"), `a[needle]\n${"x".repeat(20 * 1024)}\n`);
    await fs.writeFile(join(root, "many.txt"), Array.from({ length: 10_001 }, () => "needle").join("\n"));
    await fs.writeFile(join(root, "large-search.txt"), "needle" + "x".repeat(8 * 1024 * 1024));
    const literal = await workspace.grep({ workspace: "fixture", path: ".", pattern: "[needle]", include: ["literal.txt"], maxMatches: 10 });
    assert.equal(literal.matches[0]?.content, "a[needle]");
    const longLine = await workspace.grep({ workspace: "fixture", path: ".", pattern: "x", include: ["literal.txt"], maxMatches: 10 });
    assert.equal(Buffer.byteLength(longLine.matches[0]?.content ?? ""), 16 * 1024);
    const many = await workspace.grep({ workspace: "fixture", path: ".", pattern: "needle", include: ["many.txt"], maxMatches: 10_000 });
    assert.equal(many.matches.length, 10_000);
    assert.equal(many.truncated, true);
    const bounded = await workspace.grep({ workspace: "fixture", path: ".", pattern: "needle", include: ["large-search.txt"], maxMatches: 10 });
    assert.equal(bounded.truncated, true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("glob counts matching files rather than traversed nonmatches", async () => {
  const { root, workspace } = await fixtureWorkspace();
  try {
    const noise = join(root, "a-noise");
    await fs.mkdir(noise);
    for (let index = 0; index < 10_001; index += 1) {
      await fs.writeFile(join(noise, `file-${index}.tmp`), "x");
    }
    await fs.writeFile(join(root, "z-later.match"), "x");
    const result = await workspace.glob({ workspace: "fixture", path: ".", pattern: "*.match", maxResults: 10, respectGitignore: true });
    assert.deepEqual(result.matches, ["z-later.match"]);
    assert.equal(result.truncated, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("descriptor-relative mutations reject symlink traversal and replacement", async () => {
  const { root, workspace } = await fixtureWorkspace();
  const outside = await fs.mkdtemp(join(tmpdir(), "reach-outside-"));
  try {
    await fs.symlink(outside, join(root, "link"));
    await assert.rejects(
      () => workspace.write({ workspace: "fixture", path: "link/escaped.txt", content: "unsafe", mode: "create" }),
      (error: unknown) => error instanceof FilesystemError && error.code === "WORKSPACE_ACCESS_DENIED",
    );
    assert.equal(await fs.stat(join(outside, "escaped.txt")).catch(() => undefined), undefined);
    await fs.mkdir(join(root, "replaceable"));
    await fs.rm(join(root, "replaceable"), { recursive: true });
    await fs.symlink(outside, join(root, "replaceable"));
    await assert.rejects(
      () => workspace.write({ workspace: "fixture", path: "replaceable/nope.txt", content: "unsafe", mode: "create" }),
      (error: unknown) => error instanceof FilesystemError && error.code === "WORKSPACE_ACCESS_DENIED",
    );
    assert.equal(await fs.stat(join(outside, "nope.txt")).catch(() => undefined), undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
test("grant issuance and expiry use the same injected clock", () => {
  let now = 1_000;
  const grants = new GrantStore(() => now);
  const grant = grants.issue("fixture", "notes", ["fs.write"]);
  assert.equal(Date.parse(grant.expiresAt), now + GRANT_TTL_MS);
  assert.equal(grants.matches(grant.grantId, "fs.write", "fixture", "notes/a.txt"), true);
  assert.equal(grants.matches(grant.grantId, "fs.edit", "fixture", "notes/a.txt"), false);
  now += GRANT_TTL_MS;
  assert.equal(grants.matches(grant.grantId, "fs.write", "fixture", "notes/a.txt"), false);
});

test("grant storage normalizes paths and owns its method list", () => {
  const grants = new GrantStore(() => 1_000);
  const methods: Array<"fs.write" | "fs.edit"> = ["fs.write"];
  const grant = grants.issue("fixture", " ./notes// ", methods);
  methods.push("fs.edit");
  assert.equal(grants.matches(grant.grantId, "fs.write", "fixture", "notes/a.txt"), true);
  assert.equal(grants.matches(grant.grantId, "fs.edit", "fixture", "notes/a.txt"), false);
  assert.throws(() => grants.issue("fixture", "../outside", ["fs.write"]), /invalid grant path/);
});

test("text reads and supported mutations reject invalid UTF-8 without modifying the file", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "reach-utf8-"));
  try {
    const workspace = new WorkspaceFilesystem({ fixture: root });
    const bytes = Buffer.from([0xff, 0xfe]);
    await fs.writeFile(join(root, "invalid.txt"), bytes);
    const invalidUtf8 = (error: unknown) => error instanceof FilesystemError && error.code === "INVALID_UTF8";
    const mutationError = process.platform === "linux" ? invalidUtf8
      : (error: unknown) => error instanceof FilesystemError && error.code === "WORKSPACE_ACCESS_DENIED";
    await assert.rejects(workspace.read({ workspace: "fixture", path: "invalid.txt", startLine: 1, maxLines: 1 }), invalidUtf8);
    await assert.rejects(workspace.write({ workspace: "fixture", path: "invalid.txt", content: "new", mode: "overwrite" }), mutationError);
    await assert.rejects(workspace.edit({ workspace: "fixture", path: "invalid.txt", oldString: "x", newString: "y", replaceAll: false }), mutationError);
    assert.deepEqual(await fs.readFile(join(root, "invalid.txt")), bytes);
    await assert.rejects(workspace.read({ workspace: "fixture", path: ".", startLine: 1, maxLines: 1 }), (error: unknown) => error instanceof FilesystemError && error.code === "FILE_NOT_FOUND");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
