import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ContractError,
  INVALID_PARAMS,
  parseFsReadRequest,
  parseFsReadResult,
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
