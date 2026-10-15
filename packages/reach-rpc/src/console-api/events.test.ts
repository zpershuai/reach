import assert from "node:assert/strict";
import { test } from "node:test";
import { controllerCaller, GatewayEvents } from "./events.js";

test("event ids increase, the replay buffer is bounded, and listeners are isolated", () => {
  let failures = 0;
  const events = new GatewayEvents(() => 123, () => { failures++; });
  const received: number[] = [];
  const unsubscribe = events.subscribe(() => { throw new Error("broken subscriber"); });
  events.subscribe(event => { received.push(event.id); });
  for (let index = 0; index < 4200; index++) events.emit("rpc.started");
  assert.equal(failures, 4200);
  assert.equal(received.length, 4200);
  assert.equal(events.replay(0).length, 2000);
  assert.equal(events.replay(0)[0].id, 2201);
  assert.deepEqual(events.replay(4180).map(event => event.id), Array.from({ length: 20 }, (_, index) => 4181 + index));
  assert.equal(events.replay(4180)[0].ts, 123);
  unsubscribe();
  events.emit("admin.action");
  assert.equal(failures, 4200);
});

test("controller labels accept bounded printable headers and otherwise fall back", () => {
  for (const value of [undefined, "", "x".repeat(65), "bad\nlabel", ["one", "two"]]) {
    assert.equal(controllerCaller(value).label, "Controller API");
  }
  assert.deepEqual(controllerCaller("Hermes Agent"), { type: "controller", label: "Hermes Agent", verified: false });
  assert.equal(controllerCaller("x".repeat(64)).label.length, 64);
});
