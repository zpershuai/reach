import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import WebSocket from "ws";
import {
  createGateway,
  type GatewayOptions,
  DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
  SESSION_WANTED_HEARTBEAT_INTERVAL_SECONDS,
} from "./gateway.js";

async function withGateway(
  check: (baseUrl: string) => Promise<void>,
  options: GatewayOptions = {},
): Promise<void> {
  const server = createGateway(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("gateway did not bind to a TCP port");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await check(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test("heartbeat returns the idle interval for device information", async () => {
  await withGateway(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device: { id: "engine-1", platform: "linux" } }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { intervalSeconds: DEFAULT_HEARTBEAT_INTERVAL_SECONDS });
  });
});

test("heartbeat rejects a missing device object", async () => {
  await withGateway(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device: "engine-1" }),
    });

    assert.equal(response.status, 400);
  });
});

test("session-wanted heartbeat returns one-time session credentials", async () => {
  await withGateway(async (baseUrl) => {
    const control = await fetch(`${baseUrl}/session-wanted`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wanted: true }),
    });
    assert.equal(control.status, 200);
    assert.deepEqual(await control.json(), { wanted: true });

    const heartbeat = await fetch(`${baseUrl}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device: { id: "engine-1" } }),
    });
    assert.equal(heartbeat.status, 200);
    const payload = await heartbeat.json() as {
      intervalSeconds: number;
      token: string;
      wssUrl: string;
    };
    assert.equal(payload.intervalSeconds, SESSION_WANTED_HEARTBEAT_INTERVAL_SECONDS);
    assert.match(payload.token, /^[0-9a-f-]{36}$/);
    assert.equal(payload.wssUrl, baseUrl.replace("http://", "ws://") + "/session");

    const repeatedHeartbeat = await fetch(`${baseUrl}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device: { id: "engine-1" } }),
    });
    assert.deepEqual(await repeatedHeartbeat.json(), payload);

    await new Promise<void>((resolve) => {
      const invalid = new WebSocket(`${payload.wssUrl}?token=invalid`);
      invalid.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve();
      });
      invalid.once("error", () => resolve());
    });
  });
});

test("session-wanted control rejects invalid payloads", async () => {
  await withGateway(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/session-wanted`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wanted: "yes" }),
    });

    assert.equal(response.status, 400);
  });
});

test("job completion closes the session and restores the idle heartbeat", async () => {
  const events: string[] = [];
  let resolveSessionClosed: () => void = () => {};
  const sessionClosed = new Promise<void>((resolve) => {
    resolveSessionClosed = resolve;
  });
  await withGateway(async (baseUrl) => {
    const control = await fetch(`${baseUrl}/session-wanted`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wanted: true }),
    });
    assert.equal(control.status, 200);

    const heartbeat = await fetch(`${baseUrl}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device: { id: "engine-1" } }),
    });
    const session = await heartbeat.json() as { wssUrl: string; token: string };

    const engine = new WebSocket(`${session.wssUrl}?token=${session.token}`);
    await once(engine, "open");
    engine.send(JSON.stringify({ type: "job.done" }));
    await Promise.all([once(engine, "close"), sessionClosed]);

    assert.deepEqual(events, [
      "Reach session connected",
      "Reach session job done",
      "Reach session closed",
    ]);

    const idleHeartbeat = await fetch(`${baseUrl}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device: { id: "engine-1" } }),
    });
    assert.deepEqual(await idleHeartbeat.json(), {
      intervalSeconds: DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
    });
  }, {
    logger: (message) => {
      events.push(message);
      if (message === "Reach session closed") {
        resolveSessionClosed();
      }
    },
  });
});
