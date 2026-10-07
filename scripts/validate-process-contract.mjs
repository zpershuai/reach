import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { processSchemas, processTaskSchema, processLogsResultSchema, processListResultSchema, requestEnvelopeSchema } from "../packages/reach-rpc/dist/index.js";
const fixture = new URL("../fixtures/process.contract.json", import.meta.url);
const cases = JSON.parse(readFileSync(fixture, "utf8"));
const schemas = { ...processSchemas, task: processTaskSchema, logs: processLogsResultSchema, list: processListResultSchema, envelope: requestEnvelopeSchema };
const output = cases.map((entry) => {
  const result = schemas[entry.schema].safeParse(entry.input);
  assert.equal(result.success, entry.valid, `${entry.schema} acceptance`);
  if (!result.success) return { valid: false };
  assert.deepEqual(result.data, entry.expected, `${entry.schema} payload`);
  return { valid: true, payload: result.data };
});
const rust = spawnSync("cargo", ["run", "--quiet", "--locked", "-p", "reach-rpc", "--bin", "process-roundtrip", "--", fixture.pathname], { cwd: new URL("../", import.meta.url), encoding: "utf8" });
assert.equal(rust.status, 0, rust.stderr);
assert.deepEqual(JSON.parse(rust.stdout), output);
console.log(`${cases.length} process contract fixtures agree across Rust and TypeScript.`);
