import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";
import { GatewayEvents } from "./events.js";
import { serveEvents } from "./sse.js";

test("SSE drops a stalled subscriber without delaying or suppressing other events", () => {
  const events = new GatewayEvents();
  const response = Object.assign(new EventEmitter(), {
    destroyed: false, writableEnded: false, writableLength: 1024 * 1024 + 1,
    writeHead: () => {}, flushHeaders: () => {}, write: () => { throw new Error("must drop before writing"); },
    destroy: () => { response.destroyed = true; response.emit("close"); },
  });
  const request = { headers: {} } as IncomingMessage;
  const stop = serveEvents(events, request, response as unknown as ServerResponse);
  let received = 0;
  events.subscribe(() => { received++; });
  const start = performance.now();
  for (let index = 0; index < 1000; index++) events.emit("rpc.finished", { requestId: String(index) });
  assert.ok(performance.now() - start < 1000);
  assert.equal(response.destroyed, true);
  assert.equal(received, 1000);
  stop();
});
