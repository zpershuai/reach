import assert from "node:assert/strict";
import { test } from "node:test";
import { auditInvocation, auditRecord } from "./audit.js";
import type { GatewayEvent } from "./events.js";
import { GatewayEvents } from "./events.js";
import { AuditWriter } from "./audit.js";
import { ConsoleStore } from "./store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("audit canonicalizes wrappers and allows only method-specific metadata", () => {
  const params = {
    workspace: "default", path: "a.txt", script: "job.cjs", processId: "process-1", launchId: "launch-1",
    content: "private-content", oldString: "private-old", newString: "private-new", pattern: "private-pattern",
    args: ["private-arg"], token: "private-token", grantId: "private-grant", output: "private-output",
  };
  for (const [method, expected] of [
    ["fs.write", { workspace: "default", path: "a.txt", method: "fs.write", methodClass: "write" }],
    ["fs.grep", { workspace: "default", path: "a.txt", method: "fs.grep", methodClass: "read" }],
    ["process.run", { workspace: "default", script: "job.cjs", processId: "process-1", launchId: "launch-1", method: "process.run", methodClass: "exec" }],
    ["process.stop", { workspace: "default", script: "job.cjs", processId: "process-1", launchId: "launch-1", method: "process.stop", methodClass: "control" }],
  ] as const) {
    for (const wrapped of [false, true]) {
      const fields = wrapped ? auditInvocation("tool.call", { name: method, arguments: params }) : auditInvocation(method, params);
      assert.deepEqual(fields, expected);
      const event = { ...params, ...fields, id: 1, ts: 123, type: "rpc.finished", caller: { type: "controller", label: "Test client", verified: false, token: "private-token" } } as unknown as GatewayEvent;
      // Events only receive the extracted fields in production. Check the storage boundary independently.
      const record = auditRecord(event);
      assert.ok(!JSON.stringify(record).includes("private-"));
      assert.equal(record.method, method);
    }
  }
  assert.throws(() => auditInvocation("tool.call", { name: "tool.call", arguments: params }));
});

test("audit batching runs off the emitter, bounds the queue and flushes on shutdown", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reach-audit-"));
  const store = new ConsoleStore(directory);
  const events = new GatewayEvents();
  const writer = new AuditWriter(store, events);
  try {
    for (let index = 0; index < 10_100; index++) events.emit("rpc.finished", { requestId: String(index), caller: { type: "controller", label: "Client A", verified: false } });
    assert.equal(writer.pending, 10_000);
    assert.equal(writer.dropped, 100);
    assert.equal(store.db.prepare("SELECT count(*) AS count FROM activity").get()!.count, 0);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(writer.pending, 9800);
    assert.equal(store.db.prepare("SELECT count(*) AS count FROM activity").get()!.count, 200);
    writer.close();
    assert.equal(store.db.prepare("SELECT count(*) AS count FROM activity").get()!.count, 10_000);
    assert.equal(store.db.prepare("SELECT request_id FROM activity ORDER BY id LIMIT 1").get()!.request_id, "100");
    assert.equal(store.db.prepare("SELECT label FROM clients").get()!.label, "Client A");
  } finally {
    writer.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("audit flushes a partial batch on the 250ms timer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reach-audit-timer-"));
  const store = new ConsoleStore(directory);
  const events = new GatewayEvents();
  const writer = new AuditWriter(store, events);
  try {
    events.emit("admin.action", { action: "settings.update" });
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(store.db.prepare("SELECT count(*) AS count FROM activity").get()!.count, 1);
  } finally { writer.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});


test("observes Controller clients before their first RPC without persisting session events", () => {
  const directory = mkdtempSync(join(tmpdir(), "reach-client-observation-"));
  const store = new ConsoleStore(directory);
  const events = new GatewayEvents();
  const writer = new AuditWriter(store, events);
  try {
    events.emit("session.state", { status: "ready", caller: { type: "controller", label: "Console-free client", verified: false } });
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM clients").get()!.n, 0);
    writer.flush();
    assert.equal(store.db.prepare("SELECT label FROM clients").get()!.label, "Console-free client");
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM activity").get()!.n, 0);
  } finally { writer.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
