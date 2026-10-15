import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ActivityLog, csvCell } from "./activity.js";
import { AuditWriter } from "./audit.js";
import { GatewayEvents } from "./events.js";
import { ConsoleStore } from "./store.js";

test("activity filters, pagination, streamed exports and daily retention share the same records", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reach-activity-"));
  const store = new ConsoleStore(directory);
  let now = Date.parse("2026-10-15T12:00:00Z");
  const events = new GatewayEvents(() => now);
  const writer = new AuditWriter(store, events);
  const activity = new ActivityLog(store, () => 30, () => now);
  const caller = { type: "controller", label: 'Client "A", test', verified: false } as const;
  const day = 86_400_000;
  const emit = (ts: number, engineId: string, methodClass: "read" | "write", outcome: "ok" | "error" | "denied"): void => {
    const current = now;
    now = ts;
    events.emit("rpc.finished", { engineId, caller, method: methodClass === "read" ? "fs.read" : "fs.write", methodClass, outcome, path: 'notes/"a,b".md' });
    now = current;
  };
  emit(now - 31 * day, "old", "read", "ok");
  emit(now - 1000, "engine-a", "read", "ok");
  emit(now, "engine-a", "write", "denied");
  emit(now, "engine-b", "read", "error");
  emit(now, "engine-a", "write", "error");
  writer.flush();
  const server = createServer((request, response) => {
    void activity.export(response, request.url === "/csv" ? "csv" : "jsonl", { engineId: "engine-a", outcome: "not_ok" }, events).catch(() => response.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const rows = activity.query().rows;
    assert.equal(rows.length, 5);
    assert.ok(rows[0].id > rows[1].id);
    const first = activity.query({ limit: 2 });
    assert.ok(first.cursor);
    const second = activity.query({ limit: 2, cursor: first.cursor });
    const third = activity.query({ limit: 2, cursor: second.cursor! });
    assert.deepEqual([...first.rows, ...second.rows, ...third.rows].map(row => row.id), rows.map(row => row.id));
    assert.equal(third.cursor, null);
    assert.equal(activity.query({ engineId: "engine-a", outcome: "not_ok" }).rows.length, 2);
    assert.equal(activity.query({ outcome: "ok" }).rows.length, 2);
    assert.equal(activity.query({ clientLabel: caller.label, methodClass: "write", from: now, to: now }).rows.length, 2);
    assert.equal(activity.query({ clientLabel: "missing" }).rows.length, 0);
    assert.equal(activity.query({ engineId: "engine-b" }).rows.length, 1);
    assert.equal(activity.query({ outcome: "denied" }).rows.length, 1);
    assert.throws(() => activity.query({ cursor: "invalid" }), /cursor/);
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const csv = await fetch(`http://127.0.0.1:${address.port}/csv`);
    assert.equal(csv.headers.get("content-disposition"), 'attachment; filename="reach-activity-2026-10-15.csv"');
    const text = await csv.text();
    assert.equal(text.trim().split("\r\n").length, 3);
    assert.ok(text.includes('"Client ""A"", test"'));
    assert.ok(text.includes('"notes/""a,b"".md"'));
    const jsonl = await fetch(`http://127.0.0.1:${address.port}/jsonl`);
    assert.equal(jsonl.headers.get("content-type"), "application/x-ndjson");
    const lines = (await jsonl.text()).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(lines.map(row => row.outcome), ["error", "denied"]);
    assert.ok(lines.every(row => row.engineId === "engine-a"));
    writer.flush();
    assert.deepEqual(events.replay(0).filter(event => event.type === "admin.action").map(event => event.action), ["activity.export.csv", "activity.export.jsonl"]);
    assert.equal(activity.prune(), 1);
    assert.equal(activity.query({ engineId: "old" }).rows.length, 0);
    assert.equal(csvCell('a\nb"c'), '"a\nb""c"');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    activity.close(); writer.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  }
});
