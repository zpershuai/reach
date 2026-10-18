import { GatewayEvents, type GatewayEvent } from "./events.js";
import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { WebSocket } from "ws";
import { createGateway } from "../gateway.js";
import { parseSessionReady } from "../index.js";
import { engineView } from "./server.js";

test("readiness preserves workspaces and distinguishes enabled, disabled and unreported execution", async () => {
  for (const processWorkspaces of [undefined, [], ["scripts"]]) {
    const events = new GatewayEvents();
    const recorded: GatewayEvent[] = []; events.subscribe(event => recorded.push(event));
    const gateway = createGateway({ logger: () => {}, events });
    gateway.listen(0, "127.0.0.1"); await once(gateway, "listening");
    let socket: WebSocket | undefined;
    try {
      const address = gateway.address(); assert.ok(address && typeof address === "object");
      const base = `http://127.0.0.1:${address.port}`;
      await fetch(`${base}/session/open`, { method: "POST", body: "{}" });
      const heartbeat = await (await fetch(`${base}/heartbeat`, { method: "POST", body: '{"device":{}}' })).json() as { token: string; sessionId: string };
      socket = new WebSocket(`${base.replace("http:", "ws:")}/session?token=${heartbeat.token}`); await once(socket, "open");
      const ready = { type: "session.ready", protocol: "reach-rpc", version: "1.0", sessionId: heartbeat.sessionId, engineId: "local-engine", workspaces: ["default", "scripts"], methods: ["fs.read", "process.run"], ...(processWorkspaces === undefined ? {} : { processWorkspaces }) };
      assert.deepEqual(parseSessionReady(ready).processWorkspaces, processWorkspaces);
      socket.send(JSON.stringify(ready));
      for (let attempt = 0; attempt < 100 && gateway.registry.apis.get("local-engine")!.status().status !== "ready"; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
      const view = engineView(gateway.registry.engines.get("local-engine")!, gateway.registry, Date.now(), 120);
      const session = view.session as { status: string; workspaces: string[]; processWorkspaces?: string[] };
      assert.equal(session.status, "ready");
      assert.equal(engineView(gateway.registry.engines.get("local-engine")!, gateway.registry, Date.now() + 3_600_000, 120).online, true);
      assert.deepEqual(session.workspaces, ["default", "scripts"]); assert.deepEqual(session.processWorkspaces, processWorkspaces);
      socket.send(JSON.stringify({ ...ready, workspaces: ["default", "docs"], processWorkspaces: ["docs"] }));
      for (let attempt = 0; attempt < 100 && !recorded.some(event => event.type === "session.state" && event.workspaces?.includes("docs")); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
      const refreshed = recorded.filter(event => event.type === "session.state").at(-1)!;
      assert.equal(refreshed.status, "ready");
      assert.equal(refreshed.sessionId, heartbeat.sessionId);
      assert.deepEqual(refreshed.workspaces, ["default", "docs"]);
      assert.deepEqual(refreshed.processWorkspaces, ["docs"]);

    } finally {
      if (socket && socket.readyState !== WebSocket.CLOSED) { const closed = once(socket, "close"); socket.terminate(); await closed; }
      await new Promise<void>(resolve => gateway.close(() => resolve()));
    }
  }
});
