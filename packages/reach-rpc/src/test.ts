import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
