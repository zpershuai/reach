import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { operationClass, parseClientPermissions, permits, visibleWorkspaces } from "./client-policy.js";

interface PolicyFixture {
  name: string;
  permissions: unknown;
  requests: Array<{ engineId: string; workspace: string; method: string; allowed: boolean }>;
  visible: Record<string, string[]>;
}

const fixtures = JSON.parse(readFileSync(new URL("../../../fixtures/client-access-policy.json", import.meta.url), "utf8")) as { cases: PolicyFixture[] };

for (const fixture of fixtures.cases) {
  test(`client policy: ${fixture.name}`, () => {
    const permissions = parseClientPermissions(fixture.permissions);
    for (const request of fixture.requests) assert.equal(permits(permissions, request.engineId, request.workspace, request.method), request.allowed, JSON.stringify(request));
    for (const [engine, expected] of Object.entries(fixture.visible)) assert.deepEqual(visibleWorkspaces(permissions, engine), expected);
  });
}

test("permissions reject malformed values, wildcards, duplicate resources and typo fields", () => {
  const valid = { engineId: "engine-a", workspace: "docs", read: true, write: false, execute: false };
  for (const invalid of [null, {}, [null], [{ ...valid, engineId: "*" }], [{ ...valid, workspace: "*" }], [{ ...valid, read: "true" }], [{ ...valid, extra: true }], [valid, valid]]) {
    assert.throws(() => parseClientPermissions(invalid));
  }
  assert.equal(operationClass("__proto__"), undefined);
  assert.equal(operationClass("toString"), undefined);
  assert.equal(permits([valid], "engine-a", "docs ", "fs.read"), false);
});
