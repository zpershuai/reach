import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import type { Socket } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
  createGateway,
  type GatewayOptions,
  DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
  SESSION_WANTED_HEARTBEAT_INTERVAL_SECONDS,
  MAX_HTTP_BODY_BYTES,
  MAX_WEBSOCKET_TEXT_BYTES,
  MAX_PENDING_RPCS,
  normalizeWorkspacePath,
} from "./gateway.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

async function withGateway(
  check: (baseUrl: string) => Promise<void>,
  options: GatewayOptions = {},
): Promise<void> {
  const server = createGateway(options);
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
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
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function wsBaseUrl(baseUrl: string): string {
  return baseUrl.replace("http://", "ws://");
}

async function openEngineSession(
  baseUrl: string,
  options: { ready?: boolean } = {},
): Promise<{ socket: WebSocket; sessionId: string; endpoint: string; token: string }> {
  await fetch(`${baseUrl}/session-wanted`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wanted: true }),
  });
  const heartbeat = await fetch(`${baseUrl}/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device: { id: "engine-1" } }),
  });
  const session = await heartbeat.json() as { endpoint: string; token: string; sessionId: string; leaseExpiresAt: string };
  const socket = new WebSocket(`${wsBaseUrl(baseUrl)}${session.endpoint}?token=${session.token}`);
  await once(socket, "open");
  if (options.ready !== false) {
    // A live Engine announces readiness before the Gateway forwards RPC.
    socket.send(JSON.stringify({
      type: "session.ready",
      protocol: "reach-rpc",
      version: "1.0",
      sessionId: session.sessionId,
      engineId: "test-engine",
      workspaces: ["fixture"],
      methods: ["fs.read", "fs.write", "fs.edit", "fs.list", "fs.stat", "fs.glob", "fs.grep"],
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return { socket, ...session };
}

/** Minimal Model B engine peer: announces readiness and answers Gateway-forwarded requests. */
function attachMockEngine(
  socket: WebSocket,
  handler?: (envelope: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>,
): void {
  socket.on("message", async (data) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.type !== "request") return;
    const requestId = message.requestId;
    if (typeof requestId !== "string") return;

    if (message.method === "session.complete") {
      socket.send(JSON.stringify({ type: "response", requestId, result: { ok: true } }));
      socket.send(JSON.stringify({ type: "job.done" }));
      return;
    }

    try {
      const reply = handler
        ? await handler(message)
        : { type: "response", requestId, result: { ok: true, method: message.method } };
      socket.send(JSON.stringify(reply));
    } catch (error) {
      const code = error instanceof Error ? error.message : "INVALID_PARAMS";
      socket.send(JSON.stringify({ type: "error", requestId, error: { code } }));
    }
  });
}

function rpcBody(requestId: string, method: string, params: unknown, permission?: unknown): Record<string, unknown> {
  return {
    requestId,
    method,
    params,
    ...(permission === undefined ? {} : { permission }),
  };
}

test("session controls bind pending intent and reject a replacement id", async () => {
  await withGateway(async (baseUrl) => {
    const post = (path: string, body: unknown) => fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const opened = await post("/session/open", { sessionId: "intent-a" });
    assert.equal((await opened.json() as { sessionId: string }).sessionId, "intent-a");
    assert.equal((await post("/session/close", { sessionId: "intent-b" })).status, 409);
    assert.equal((await (await fetch(`${baseUrl}/session/status`)).json() as { status: string }).status, "wanted");
    assert.equal((await post("/session/close", { sessionId: "intent-a" })).status, 200);
  });
});

test("reopening an intent preserves pending credentials and rejects another owner", async () => {
  await withGateway(async (baseUrl) => {
    const post = (path: string, body: unknown) => fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    await post("/session/open", { sessionId: "intent-a" });
    assert.equal((await post("/session/open", { sessionId: "intent-b" })).status, 409);
    const before = await (await post("/heartbeat", { device: { id: "engine" } })).json();
    assert.equal((await post("/session/open", { sessionId: "intent-a" })).status, 200);
    assert.equal((await post("/session-wanted", { wanted: true })).status, 200);
    assert.equal((await post("/session/open", {})).status, 200);
    assert.equal((await post("/session/open", { sessionId: "intent-b" })).status, 409);
    const after = await (await post("/heartbeat", { device: { id: "engine" } })).json();
    assert.deepEqual(after, before);
    assert.equal((after as { sessionId: string }).sessionId, "intent-a");
    // The preserved token must still connect the Engine.
    const socket = new WebSocket(`${wsBaseUrl(baseUrl)}${(after as { endpoint: string }).endpoint}?token=${(after as { token: string }).token}`);
    await once(socket, "open");
    socket.close();
    await once(socket, "close");
  });
});

test("Gateway binds one RPC deadline and never forwards expired work", async () => {
  await withGateway(async (baseUrl) => {
    const { socket } = await openEngineSession(baseUrl);
    let forwarded = 0;
    attachMockEngine(socket, (envelope) => {
      forwarded += 1;
      assert.ok(typeof envelope.deadlineAt === "string");
      assert.ok(Date.parse(envelope.deadlineAt as string) <= Date.now() + 30_000);
      return { type: "response", requestId: envelope.requestId, result: {} };
    });
    const post = (body: unknown) => fetch(`${baseUrl}/session/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const expired = await post({ ...rpcBody("expired", "fs.read", {}), deadlineAt: "2000-01-01T00:00:00Z" });
    assert.equal((await expired.json() as { error: { code: string } }).error.code, "DEADLINE_EXCEEDED");
    assert.equal(forwarded, 0);
    const live = await post({ ...rpcBody("live", "fs.read", {}), deadlineAt: "2100-01-01T00:00:00Z" });
    assert.equal((await live.json() as { type: string }).type, "response");
    assert.equal(forwarded, 1);
    socket.close();
    await once(socket, "close");
  });
});

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
    assert.deepEqual(await control.json(), { wanted: true, status: "wanted" });

    const heartbeat = await fetch(`${baseUrl}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device: { id: "engine-1" } }),
    });
    assert.equal(heartbeat.status, 200);
    const payload = await heartbeat.json() as {
      intervalSeconds: number;
      token: string;
      endpoint: string;
      sessionId: string;
      leaseExpiresAt: string;
    };
    assert.equal(payload.intervalSeconds, SESSION_WANTED_HEARTBEAT_INTERVAL_SECONDS);
    assert.match(payload.token, /^[0-9a-f-]{36}$/);
    assert.match(payload.sessionId, /^[0-9a-f-]{36}$/);
    assert.equal(payload.endpoint, "/session");
    assert.ok(!Number.isNaN(Date.parse(payload.leaseExpiresAt)));

    const repeatedHeartbeat = await fetch(`${baseUrl}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device: { id: "engine-1" } }),
    });
    assert.deepEqual(await repeatedHeartbeat.json(), payload);

    await new Promise<void>((resolve) => {
      const invalid = new WebSocket(`${wsBaseUrl(baseUrl)}${payload.endpoint}?token=invalid`);
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

test("session credentials are consumed once and require an explicit re-request", async () => {
  await withGateway(async (baseUrl) => {
    const heartbeat = async (): Promise<{ endpoint?: string; token?: string; intervalSeconds?: number }> => {
      const response = await fetch(`${baseUrl}/heartbeat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device: { id: "engine-1" } }),
      });
      return response.json() as Promise<{ endpoint?: string; token?: string; intervalSeconds?: number }>;
    };
    await fetch(`${baseUrl}/session-wanted`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wanted: true }),
    });
    const first = await heartbeat();
    assert.ok(first.token && first.endpoint);
    const engine = new WebSocket(`${wsBaseUrl(baseUrl)}${first.endpoint}?token=${first.token}`);
    await once(engine, "open");

    // A second connection with the same (now consumed) token is rejected.
    await new Promise<void>((resolve) => {
      const concurrent = new WebSocket(`${wsBaseUrl(baseUrl)}${first.endpoint}?token=${first.token}`);
      concurrent.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve();
      });
      concurrent.once("error", resolve);
    });
    engine.close();
    await once(engine, "close");
    assert.deepEqual(await heartbeat(), { intervalSeconds: DEFAULT_HEARTBEAT_INTERVAL_SECONDS });

    await fetch(`${baseUrl}/session-wanted`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wanted: true }),
    });
    const renewed = await heartbeat();
    assert.ok(renewed.token);
    assert.notEqual(renewed.token, first.token);
  });
});

test("gateway rejects oversized HTTP bodies and closes oversized, idle, and hard-lived sessions", async () => {
  await withGateway(async (baseUrl) => {
    const oversized = await fetch(`${baseUrl}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device: { payload: "x".repeat(MAX_HTTP_BODY_BYTES) } }),
    });
    assert.equal(oversized.status, 413);

    const { socket: oversizedSocket } = await openEngineSession(baseUrl);
    // maxPayload rejects oversized frames at the ws layer; ignore the resulting error event.
    oversizedSocket.on("error", () => undefined);
    oversizedSocket.send("x".repeat(MAX_WEBSOCKET_TEXT_BYTES + 1));
    const [oversizedCode] = await once(oversizedSocket, "close") as [number];
    assert.equal(oversizedCode, 1009);
    // The client close event can win the server's close handler. Wait until
    // the Gateway has released its live-session binding before opening again.
    await waitForStatus(baseUrl, "none");

    const { socket: idleSocket } = await openEngineSession(baseUrl);
    const [idleCode] = await once(idleSocket, "close") as [number];
    assert.equal(idleCode, 1008);
  }, { sessionIdleMs: 20, sessionDurationMs: 100 });

  await withGateway(async (baseUrl) => {
    const { socket } = await openEngineSession(baseUrl);
    const [code] = await once(socket, "close") as [number];
    assert.equal(code, 1008);
  }, { sessionIdleMs: 100, sessionDurationMs: 20 });
});

test("job completion closes the session and restores the idle heartbeat", async () => {
  const events: string[] = [];
  let resolveSessionClosed: () => void = () => {};
  const sessionClosed = new Promise<void>((resolve) => {
    resolveSessionClosed = resolve;
  });
  await withGateway(async (baseUrl) => {
    const { socket } = await openEngineSession(baseUrl);
    attachMockEngine(socket);
    const complete = await fetch(`${baseUrl}/session/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rpcBody("done-1", "session.complete", {})),
    });
    assert.equal(complete.status, 200);
    assert.equal((await complete.json() as { type: string }).type, "response");
    await Promise.all([once(socket, "close"), sessionClosed]);

    assert.deepEqual(events, [
      "Reach session connected",
      "Reach session ready",
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
      if (message === "Reach session closed") resolveSessionClosed();
    },
  });
});

test("session/rpc requires a live engine and forwards requests", async () => {
  await withGateway(async (baseUrl) => {
    const missing = await fetch(`${baseUrl}/session/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rpcBody("r1", "fs.read", { workspace: "fixture", path: "note.txt" })),
    });
    assert.equal(missing.status, 409);

    const { socket } = await openEngineSession(baseUrl);
    attachMockEngine(socket, (envelope) => ({
      type: "response",
      requestId: envelope.requestId,
      result: { content: "hello", startLine: 1, endLine: 1, totalLines: 1, truncated: false, revision: "a".repeat(64) },
    }));

    const read = await fetch(`${baseUrl}/session/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rpcBody("read-1", "fs.read", { workspace: "fixture", path: "note.txt", maxLines: 1 })),
    });
    assert.equal(read.status, 200);
    const payload = await read.json() as { type: string; requestId: string; result: { content: string } };
    assert.equal(payload.type, "response");
    assert.equal(payload.requestId, "read-1");
    assert.equal(payload.result.content, "hello");

    const tool = await fetch(`${baseUrl}/session/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rpcBody("tool-1", "tool.call", {
        name: "fs.read",
        arguments: { workspace: "fixture", path: "note.txt" },
      })),
    });
    assert.equal((await tool.json() as { type: string }).type, "response");

    socket.close();
    await once(socket, "close");
  });
});

test("gateway-issued grants are validated before forwarding mutations", async () => {
  await withGateway(async (baseUrl) => {
    const { socket } = await openEngineSession(baseUrl);
    let forwarded = 0;
    attachMockEngine(socket, (envelope) => {
      forwarded += 1;
      return { type: "response", requestId: envelope.requestId, result: { path: "note.txt", bytesWritten: 7, revision: "b".repeat(64) } };
    });

    const issued = await fetch(`${baseUrl}/grants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: "fixture", path: "note.txt", methods: ["fs.write"] }),
    });
    assert.equal(issued.status, 200);
    const grant = await issued.json() as { grantId: string; expiresAt: string };
    assert.match(grant.grantId, /^[0-9a-f-]{36}$/);
    assert.ok(Date.parse(grant.expiresAt) > Date.now());

    const forged = await fetch(`${baseUrl}/session/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rpcBody("forged", "fs.write", {
        workspace: "fixture",
        path: "note.txt",
        content: "changed",
        mode: "overwrite",
      }, { grantId: "forged" })),
    });
    assert.equal(forged.status, 200);
    assert.equal((await forged.json() as { error: { code: string } }).error.code, "PERMISSION_DENIED");
    assert.equal(forwarded, 0);

    const mismatched = await fetch(`${baseUrl}/session/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rpcBody("mismatch", "fs.write", {
        workspace: "other",
        path: "note.txt",
        content: "changed",
        mode: "overwrite",
      }, { grantId: grant.grantId })),
    });
    assert.equal((await mismatched.json() as { error: { code: string } }).error.code, "PERMISSION_DENIED");
    assert.equal(forwarded, 0);

    const allowed = await fetch(`${baseUrl}/session/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rpcBody("allowed", "fs.write", {
        workspace: "fixture",
        path: "note.txt",
        content: "changed",
        mode: "overwrite",
      }, { grantId: grant.grantId })),
    });
    assert.equal((await allowed.json() as { type: string }).type, "response");
    assert.equal(forwarded, 1);

    socket.close();
    await once(socket, "close");
  });
});

test("nested tool.call cannot bypass grant validation", async () => {
  await withGateway(async (baseUrl) => {
    const { socket } = await openEngineSession(baseUrl);
    let forwarded = 0;
    attachMockEngine(socket, (envelope) => {
      forwarded += 1;
      return { type: "response", requestId: envelope.requestId, result: { ok: true } };
    });

    const nested = await fetch(`${baseUrl}/session/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rpcBody("nested-write", "tool.call", {
        name: "tool.call",
        arguments: {
          name: "fs.write",
          arguments: { workspace: "fixture", path: "note.txt", content: "x", mode: "overwrite" },
        },
      }, { grantId: "forged" })),
    });
    // Nested tool.call is rejected before grant lookup, so the code is
    // INVALID_PARAMS even with a forged grant (no grant-state oracle).
    assert.equal(nested.status, 200);
    assert.equal((await nested.json() as { error: { code: string } }).error.code, "INVALID_PARAMS");
    assert.equal(forwarded, 0);

    const issued = await fetch(`${baseUrl}/grants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: "fixture", path: "note.txt", methods: ["fs.write"] }),
    });
    const grant = await issued.json() as { grantId: string };
    const nestedRejected = await fetch(`${baseUrl}/session/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rpcBody("nested-ok", "tool.call", {
        name: "tool.call",
        arguments: {
          name: "fs.write",
          arguments: { workspace: "fixture", path: "note.txt", content: "x", mode: "overwrite" },
        },
      }, { grantId: grant.grantId })),
    });
    assert.equal(nestedRejected.status, 200);
    assert.equal((await nestedRejected.json() as { error: { code: string } }).error.code, "INVALID_PARAMS");
    assert.equal(forwarded, 0);

    socket.close();
    await once(socket, "close");
  });
});

test("pending rpc cap returns 503 without forwarding", async () => {
  await withGateway(async (baseUrl) => {
    const { socket } = await openEngineSession(baseUrl);
    const blocked: Array<() => void> = [];
    attachMockEngine(socket, (envelope) => new Promise((resolve) => {
      blocked.push(() => resolve({ type: "response", requestId: envelope.requestId, result: { ok: true } }));
    }));

    const inflight = Array.from({ length: MAX_PENDING_RPCS }, (_, index) =>
      fetch(`${baseUrl}/session/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(rpcBody(`pending-${index}`, "fs.read", {
          workspace: "fixture",
          path: "note.txt",
          startLine: 1,
          maxLines: 10,
        })),
      }),
    );

    const deadline = Date.now() + 1000;
    while (blocked.length < MAX_PENDING_RPCS && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(blocked.length, MAX_PENDING_RPCS);

    const overflow = await fetch(`${baseUrl}/session/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rpcBody("pending-overflow", "fs.read", {
        workspace: "fixture",
        path: "note.txt",
        startLine: 1,
        maxLines: 10,
      })),
    });
    assert.equal(overflow.status, 503);
    assert.equal((await overflow.json() as { error: string }).error, "too many pending rpcs");
    assert.equal(blocked.length, MAX_PENDING_RPCS);

    for (const release of blocked) release();
    await Promise.all(inflight);
    socket.close();
    await once(socket, "close");
  });
});

test("rpc timeout closes the live session and rejects further rpcs", async () => {
  await withGateway(async (baseUrl) => {
    const { socket } = await openEngineSession(baseUrl);
    attachMockEngine(socket, () => new Promise<Record<string, unknown>>(() => {
      // Never reply: force Gateway RPC timeout.
    }));

    const timedOut = fetch(`${baseUrl}/session/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rpcBody("timeout-1", "fs.read", {
        workspace: "fixture",
        path: "note.txt",
        startLine: 1,
        maxLines: 10,
      })),
    });

    const [closeCode] = await once(socket, "close") as [number];
    assert.equal(closeCode, 1011);
    const timedOutResponse = await timedOut;
    assert.equal(timedOutResponse.status, 503);
    assert.equal((await timedOutResponse.json() as { error: string }).error, "session rpc timeout");

    const afterTimeout = await fetch(`${baseUrl}/session/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rpcBody("timeout-2", "fs.read", {
        workspace: "fixture",
        path: "note.txt",
        startLine: 1,
        maxLines: 10,
      })),
    });
    assert.equal(afterTimeout.status, 409);
  }, { sessionRpcTimeoutMs: 30 });
});

test("a shorter caller deadline leaves other pending requests and the session intact", async () => {
  await withGateway(async (baseUrl) => {
    const { socket } = await openEngineSession(baseUrl);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    attachMockEngine(socket, async (envelope) => {
      if (envelope.requestId === "first") firstStarted();
      if (envelope.requestId === "expired") return new Promise<Record<string, unknown>>(() => {});
      await gate;
      return { type: "response", requestId: envelope.requestId, result: { ok: true } };
    });
    const post = (body: unknown) => fetch(`${baseUrl}/session/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const first = post(rpcBody("first", "fs.read", {}));
    await started;
    const expired = post({ ...rpcBody("expired", "fs.read", {}), deadlineAt: new Date(Date.now() + 80).toISOString() });
    const next = post(rpcBody("next", "fs.read", {}));
    const timedOut = await expired;
    assert.equal(timedOut.status, 200);
    assert.equal((await timedOut.json() as { error: { code: string } }).error.code, "DEADLINE_EXCEEDED");
    assert.equal((await (await fetch(`${baseUrl}/session/status`)).json() as { status: string }).status, "ready");
    assert.equal((await post(rpcBody("expired", "fs.read", {}))).status, 409);
    release();
    for (const response of await Promise.all([first, next])) {
      assert.equal(response.status, 200);
      assert.equal((await response.json() as { type: string }).type, "response");
    }
    socket.close();
    await once(socket, "close");
  }, { sessionRpcTimeoutMs: 1_000 });
});

test("pending RPC execution remains active when its idle bound is shorter", async () => {
  await withGateway(async (baseUrl) => {
    const { socket } = await openEngineSession(baseUrl);
    attachMockEngine(socket, async (envelope) => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return { type: "response", requestId: envelope.requestId, result: { ok: true } };
    });
    const response = await fetch(`${baseUrl}/session/rpc`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(rpcBody("active", "fs.read", {})),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { type: string }).type, "response");
    socket.close();
    await once(socket, "close");
  }, { sessionIdleMs: 50, sessionRpcTimeoutMs: 1_000 });
});

test("timed-out requestId cannot be retried across session teardown", async () => {
  await withGateway(async (baseUrl) => {
    const first = await openEngineSession(baseUrl);
    attachMockEngine(first.socket, () => new Promise<Record<string, unknown>>(() => {
      // Never reply: force Gateway RPC timeout.
    }));

    const timedOut = fetch(`${baseUrl}/session/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rpcBody("stuck-request", "fs.read", {
        workspace: "fixture",
        path: "note.txt",
        startLine: 1,
        maxLines: 10,
      })),
    });
    const [firstCloseCode] = await once(first.socket, "close") as [number];
    assert.equal(firstCloseCode, 1011);
    const timedOutResponse = await timedOut;
    assert.equal(timedOutResponse.status, 503);

    // A fresh session must still refuse the same requestId: the Engine may have
    // already applied a timed-out mutation, and retrying it would re-execute it.
    const second = await openEngineSession(baseUrl);
    let forwarded = 0;
    attachMockEngine(second.socket, (envelope) => {
      forwarded += 1;
      return { type: "response", requestId: envelope.requestId, result: { ok: true } };
    });
    const retry = await fetch(`${baseUrl}/session/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rpcBody("stuck-request", "fs.read", {
        workspace: "fixture",
        path: "note.txt",
        startLine: 1,
        maxLines: 10,
      })),
    });
    assert.equal(retry.status, 409);
    assert.equal((await retry.json() as { error: string }).error, "duplicate requestId");
    assert.equal(forwarded, 0);

    // A different requestId on the fresh session still works.
    const fresh = await fetch(`${baseUrl}/session/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rpcBody("fresh-request", "fs.read", {
        workspace: "fixture",
        path: "note.txt",
        startLine: 1,
        maxLines: 10,
      })),
    });
    assert.equal(fresh.status, 200);
    assert.equal(forwarded, 1);

    second.socket.close();
    await once(second.socket, "close");
  }, { sessionRpcTimeoutMs: 30 });
});

test("grant path scope rejects .. escapes and normalizes grant paths", async () => {
  assert.equal(normalizeWorkspacePath("note.txt/../escaped.txt"), undefined);
  assert.equal(normalizeWorkspacePath("notes/./today.txt"), "notes/today.txt");

  await withGateway(async (baseUrl) => {
    const badGrant = await fetch(`${baseUrl}/grants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: "fixture", path: "note.txt/../other.txt", methods: ["fs.write"] }),
    });
    assert.equal(badGrant.status, 400);

    const { socket } = await openEngineSession(baseUrl);
    let forwarded = 0;
    attachMockEngine(socket, (envelope) => {
      forwarded += 1;
      return { type: "response", requestId: envelope.requestId, result: { ok: true } };
    });

    const issued = await fetch(`${baseUrl}/grants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: "fixture", path: "note.txt", methods: ["fs.write"] }),
    });
    const grant = await issued.json() as { grantId: string };

    const escaped = await fetch(`${baseUrl}/session/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rpcBody("escape", "fs.write", {
        workspace: "fixture",
        path: "note.txt/../escaped.txt",
        content: "x",
        mode: "overwrite",
      }, { grantId: grant.grantId })),
    });
    assert.equal((await escaped.json() as { error: { code: string } }).error.code, "PERMISSION_DENIED");
    assert.equal(forwarded, 0);

    socket.close();
    await once(socket, "close");
  });
});

test("Engine deadline, closed errors, and lost replies protect request ids across teardown", async () => {
  for (const code of ["DEADLINE_EXCEEDED", "SESSION_CLOSED", "disconnect"]) {
    await withGateway(async (baseUrl) => {
      const { socket } = await openEngineSession(baseUrl);
      let forwarded = 0;
      let started!: () => void;
      const received = new Promise<void>((resolve) => { started = resolve; });
      attachMockEngine(socket, (envelope) => {
        forwarded += 1;
        started();
        return code === "disconnect" ? new Promise<Record<string, unknown>>(() => {})
          : { type: "error", requestId: envelope.requestId, error: { code } };
      });
      const grant = await (await fetch(`${baseUrl}/grants`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace: "fixture", path: "note.txt", methods: ["fs.write"] }),
      })).json() as { grantId: string };
      const body = rpcBody("uncertain-write", "fs.write", { workspace: "fixture", path: "note.txt", content: "x", mode: "overwrite" }, { grantId: grant.grantId });
      const post = () => fetch(`${baseUrl}/session/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const pending = post();
      await received;
      if (code !== "disconnect") {
        const response = await pending;
        assert.equal((await response.json() as { error: { code: string } }).error.code, code);
      }
      socket.close();
      await once(socket, "close");
      await waitForStatus(baseUrl, "none");
      if (code === "disconnect") assert.equal((await pending).status, 503);
      const next = await openEngineSession(baseUrl);
      attachMockEngine(next.socket, (envelope) => {
        forwarded += 1;
        return { type: "response", requestId: envelope.requestId, result: { ok: true } };
      });
      const retried = await post();
      assert.equal(retried.status, 409);
      assert.equal((await retried.json() as { error: string }).error, "duplicate requestId");
      assert.equal(forwarded, 1);
      next.socket.close();
      await once(next.socket, "close");
    });
  }
});

test("failed websocket upgrade does not permanently brick session issuance", async () => {
  const { connect } = await import("node:net");
  await withGateway(async (baseUrl) => {
    await fetch(`${baseUrl}/session-wanted`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wanted: true }),
    });
    const heartbeat = await fetch(`${baseUrl}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device: { id: "engine-1" } }),
    });
    const session = await heartbeat.json() as { endpoint: string; token: string };
    const url = new URL(`${wsBaseUrl(baseUrl)}${session.endpoint}`);

    // Valid token, invalid WebSocket handshake (bad key) — handleUpgrade aborts.
    await new Promise<void>((resolve, reject) => {
      const socket = connect(Number(url.port), url.hostname, () => {
        socket.write(
          `GET /session?token=${session.token} HTTP/1.1\r\n`
            + `Host: ${url.host}\r\n`
            + "Upgrade: websocket\r\n"
            + "Connection: Upgrade\r\n"
            + "Sec-WebSocket-Key: not-valid-base64!!!\r\n"
            + "Sec-WebSocket-Version: 13\r\n\r\n",
        );
      });
      socket.once("data", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", reject);
      socket.once("close", () => resolve());
    });

    // Without the fix, sessionLive stays true and this heartbeat would omit credentials
    // even after a fresh session-wanted. With the fix, re-request still works.
    await fetch(`${baseUrl}/session-wanted`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wanted: true }),
    });
    const renewed = await fetch(`${baseUrl}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device: { id: "engine-1" } }),
    });
    const payload = await renewed.json() as { token?: string; endpoint?: string; intervalSeconds: number };
    assert.equal(payload.intervalSeconds, SESSION_WANTED_HEARTBEAT_INTERVAL_SECONDS);
    assert.ok(payload.token && payload.endpoint);

    const socket = new WebSocket(`${wsBaseUrl(baseUrl)}${payload.endpoint}?token=${payload.token}`);
    await once(socket, "open");
    socket.close();
    await once(socket, "close");
  });
});

test("duplicate session requestIds are rejected after forward or timeout", async () => {
  await withGateway(async (baseUrl) => {
    const { socket } = await openEngineSession(baseUrl);
    attachMockEngine(socket, async (envelope) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { type: "response", requestId: envelope.requestId, result: { ok: true } };
    });

    const first = await fetch(`${baseUrl}/session/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rpcBody("same-id", "fs.read", { workspace: "fixture", path: "note.txt" })),
    });
    assert.equal(first.status, 200);

    const duplicate = await fetch(`${baseUrl}/session/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rpcBody("same-id", "fs.read", { workspace: "fixture", path: "note.txt" })),
    });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json() as { error: string }).error, "duplicate requestId");

    socket.close();
    await once(socket, "close");
  });
});

test("gateway ignores engine-originated filesystem requests", async () => {
  await withGateway(async (baseUrl) => {
    const { socket, sessionId } = await openEngineSession(baseUrl);
    attachMockEngine(socket);

    socket.send(JSON.stringify({
      type: "request",
      protocol: "reach-rpc",
      version: "1.0",
      sessionId,
      requestId: "engine-originated",
      method: "fs.read",
      params: { workspace: "default", path: "x" },
    }));

    await new Promise((resolve) => setTimeout(resolve, 30));
    const rpc = await fetch(`${baseUrl}/session/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rpcBody("still-works", "session.complete", {})),
    });
    assert.equal(rpc.status, 200);
    await once(socket, "close");
  });
});

test("session/rpc is gated on Engine readiness", async () => {
  await withGateway(async (baseUrl) => {
    const { socket, sessionId } = await openEngineSession(baseUrl, { ready: false });
    let forwarded = 0;
    attachMockEngine(socket, (envelope) => {
      forwarded += 1;
      return { type: "response", requestId: envelope.requestId, result: { ok: true } };
    });

    const before = await fetch(`${baseUrl}/session/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rpcBody("pre-ready", "fs.read", { workspace: "fixture", path: "note.txt" })),
    });
    assert.equal(before.status, 409);
    assert.equal((await before.json() as { error: string }).error, "no ready session");
    assert.equal(forwarded, 0);

    // A ready message for the wrong session id must not authorize this session.
    socket.send(JSON.stringify({
      type: "session.ready",
      protocol: "reach-rpc",
      version: "1.0",
      sessionId: "wrong-session",
      engineId: "test-engine",
      workspaces: ["fixture"],
      methods: ["fs.read"],
    }));
    const wrongId = await fetch(`${baseUrl}/session/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rpcBody("wrong-id", "fs.read", { workspace: "fixture", path: "note.txt" })),
    });
    assert.equal(wrongId.status, 409);
    assert.equal(forwarded, 0);

    socket.send(JSON.stringify({
      type: "session.ready",
      protocol: "reach-rpc",
      version: "1.0",
      sessionId,
      engineId: "test-engine",
      workspaces: ["fixture"],
      methods: ["fs.read"],
    }));
    await waitForStatus(baseUrl, "ready");

    const after = await fetch(`${baseUrl}/session/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rpcBody("post-ready", "fs.read", { workspace: "fixture", path: "note.txt" })),
    });
    assert.equal(after.status, 200);
    assert.equal(forwarded, 1);

    socket.close();
    await once(socket, "close");
  });
});

async function waitForStatus(baseUrl: string, expected: string, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  for (;;) {
    const status = await (await fetch(`${baseUrl}/session/status`)).json() as { status: string };
    if (status.status === expected) return;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for status ${expected}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("agent renewal relays a bounded lease to the Engine", async () => {
  await withGateway(async (baseUrl) => {
    const { socket, sessionId } = await openEngineSession(baseUrl);
    let renew: { sessionId: string; leaseExpiresAt: string } | undefined;
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message.type === "session.renew") renew = message as { sessionId: string; leaseExpiresAt: string };
    });

    const renewed = await fetch(`${baseUrl}/session/renew`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(renewed.status, 200);
    const payload = await renewed.json() as { sessionId: string; leaseExpiresAt: string };
    assert.equal(payload.sessionId, sessionId);
    const expiry = Date.parse(payload.leaseExpiresAt);
    assert.ok(expiry > Date.now());
    assert.ok(expiry <= Date.now() + 1100, "renewal must not exceed the policy maximum");

    await waitUntil(() => renew?.sessionId === sessionId);
    assert.equal(renew?.leaseExpiresAt, payload.leaseExpiresAt);

    socket.close();
    await once(socket, "close");
  }, { sessionDurationMs: 1000 });
});

test("renew and close controls require a live ready session", async () => {
  await withGateway(async (baseUrl) => {
    const missing = await fetch(`${baseUrl}/session/renew`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(missing.status, 409);

    const missingClose = await fetch(`${baseUrl}/session/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(missingClose.status, 409);

    const { socket } = await openEngineSession(baseUrl, { ready: false });
    const renew = await fetch(`${baseUrl}/session/renew`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(renew.status, 409);
    socket.close();
    await once(socket, "close");
  });
});

test("agent close sends session.close, rejects new RPC, and restores the idle heartbeat", async () => {
  await withGateway(async (baseUrl) => {
    const { socket, sessionId } = await openEngineSession(baseUrl);
    let closeReason: string | undefined;
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message.type === "session.close") closeReason = message.reason as string;
    });

    const closed = await fetch(`${baseUrl}/session/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(closed.status, 200);
    assert.equal((await closed.json() as { status: string }).status, "closing");
    await waitUntil(() => closeReason === "agent_requested");

    const rejectedRenew = await fetch(`${baseUrl}/session/renew`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(rejectedRenew.status, 409);

    const rpc = await fetch(`${baseUrl}/session/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rpcBody("after-close", "fs.read", { workspace: "fixture", path: "note.txt" })),
    });
    assert.equal(rpc.status, 409);

    const idleHeartbeat = await fetch(`${baseUrl}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device: { id: "engine-1" } }),
    });
    assert.deepEqual(await idleHeartbeat.json(), { intervalSeconds: DEFAULT_HEARTBEAT_INTERVAL_SECONDS });

    // The Engine completes closure; the Gateway exposes the reason.
    socket.send(JSON.stringify({ type: "session.closed", sessionId, reason: "agent_requested" }));
    socket.close();
    await once(socket, "close");
    // The client's close event can precede the server-side session cleanup.
    await waitForStatus(baseUrl, "none");
    const status = await (await fetch(`${baseUrl}/session/status`)).json() as { status: string; closureReason: string };
    assert.equal(status.status, "none");
    assert.equal(status.closureReason, "agent_requested");
  });
});

test("engine policy closure clears the session and requires a new open request", async () => {
  await withGateway(async (baseUrl) => {
    const { socket, sessionId } = await openEngineSession(baseUrl);
    socket.send(JSON.stringify({ type: "session.closed", sessionId, reason: "lease_expired" }));
    socket.close();
    await once(socket, "close");
    await waitForStatus(baseUrl, "none");

    const status = await (await fetch(`${baseUrl}/session/status`)).json() as { status: string; closureReason: string };
    assert.equal(status.status, "none");
    assert.equal(status.closureReason, "lease_expired");

    // No new credentials are minted until the Agent requests an open again.
    const idleHeartbeat = await fetch(`${baseUrl}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device: { id: "engine-1" } }),
    });
    assert.deepEqual(await idleHeartbeat.json(), { intervalSeconds: DEFAULT_HEARTBEAT_INTERVAL_SECONDS });

    const reopened = await fetch(`${baseUrl}/session/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(reopened.status, 200);
    const reHeartbeat = await fetch(`${baseUrl}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device: { id: "engine-1" } }),
    });
    const payload = await reHeartbeat.json() as { token?: string; endpoint?: string };
    assert.ok(payload.token && payload.endpoint === "/session");
  });
});

test("open is rejected while another Engine session is live", async () => {
  await withGateway(async (baseUrl) => {
    const { socket } = await openEngineSession(baseUrl);
    const second = await fetch(`${baseUrl}/session/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(second.status, 409);
    assert.equal((await second.json() as { error: string }).error, "session already active");
    socket.close();
    await once(socket, "close");
  });
});

async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("Rust engine lifecycle: open -> ready -> rpc -> renew -> close", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "reach-integration-"));
  await fs.writeFile(join(root, "note.txt"), "hello\nworld\n");
  const events: string[] = [];
  let resolveSessionClosed: () => void = () => {};
  const sessionClosedOnce = new Promise<void>((resolve) => {
    resolveSessionClosed = resolve;
  });
  try {
    await withGateway(async (baseUrl) => {
      await fetch(`${baseUrl}/session/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });

      const engine = await startEngine(baseUrl, { fixture: root });
      try {
        await waitForEvent(events, "Reach session ready", 30_000);
        const readyStatus = await (await fetch(`${baseUrl}/session/status`)).json() as { status: string; sessionId?: string };
        assert.equal(readyStatus.status, "ready");

        const read = await fetch(`${baseUrl}/session/rpc`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(rpcBody("read-1", "fs.read", {
            workspace: "fixture",
            path: "note.txt",
            maxLines: 1,
          })),
        });
        assert.equal(read.status, 200);
        const readPayload = await read.json() as { type: string; result: { content: string } };
        assert.equal(readPayload.type, "response");
        assert.equal(readPayload.result.content, "hello");

        const issued = await fetch(`${baseUrl}/grants`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspace: "fixture", path: "note.txt", methods: ["fs.write"] }),
        });
        const grant = await issued.json() as { grantId: string };

        const write = await fetch(`${baseUrl}/session/rpc`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(rpcBody("write-1", "fs.write", {
            workspace: "fixture",
            path: "note.txt",
            content: "changed",
            mode: "overwrite",
          }, { grantId: grant.grantId })),
        });
        assert.equal((await write.json() as { type: string }).type, "response");
        assert.equal(await fs.readFile(join(root, "note.txt"), "utf8"), "changed");

        // Single-level tool.call is canonicalized by the engine to a direct method.
        const wrapped = await fetch(`${baseUrl}/session/rpc`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(rpcBody("tool-1", "tool.call", {
            name: "fs.read",
            arguments: { workspace: "fixture", path: "note.txt" },
          })),
        });
        assert.equal((await wrapped.json() as { result: { content: string } }).result.content, "changed");

        const renewed = await fetch(`${baseUrl}/session/renew`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        assert.equal(renewed.status, 200);
        assert.equal((await renewed.json() as { sessionId: string }).sessionId, readyStatus.sessionId ?? "");

        await fetch(`${baseUrl}/session/close`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        await sessionClosedOnce;
        const finalStatus = await (await fetch(`${baseUrl}/session/status`)).json() as { status: string; closureReason: string };
        assert.equal(finalStatus.status, "none");
        assert.equal(finalStatus.closureReason, "agent_requested");
        assert.ok(events.includes("Reach session connected"));
        assert.ok(events.includes("Reach session ready"));
        assert.ok(events.includes("Reach session closed"));
      } finally {
        await stopEngine(engine);
      }
    }, {
      logger: (message) => {
        events.push(message);
        if (message === "Reach session closed") resolveSessionClosed();
      },
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("legacy session.complete is translated to a session close by the engine", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "reach-compat-"));
  await fs.writeFile(join(root, "note.txt"), "hi\n");
  const events: string[] = [];
  try {
    await withGateway(async (baseUrl) => {
      await fetch(`${baseUrl}/session-wanted`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wanted: true }),
      });
      const engine = await startEngine(baseUrl, { fixture: root });
      try {
        await waitForEvent(events, "Reach session ready", 30_000);
        const complete = await fetch(`${baseUrl}/session/rpc`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(rpcBody("done-1", "session.complete", {})),
        });
        assert.equal((await complete.json() as { type: string }).type, "response");
        await new Promise<void>((resolve) => {
          const started = Date.now();
          const poll = () => {
            if (events.includes("Reach session closed")) return resolve();
            if (Date.now() - started > 15_000) return resolve();
            setTimeout(poll, 50);
          };
          poll();
        });
        const status = await (await fetch(`${baseUrl}/session/status`)).json() as { status: string; closureReason: string };
        assert.equal(status.status, "none");
        assert.equal(status.closureReason, "session_complete");
      } finally {
        await stopEngine(engine);
      }
    }, { logger: (message) => events.push(message) });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("abandoned engine lease expires and the session returns to heartbeat", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "reach-lease-"));
  await fs.writeFile(join(root, "note.txt"), "x\n");
  const events: string[] = [];
  try {
    await withGateway(async (baseUrl) => {
      await fetch(`${baseUrl}/session/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      // The Gateway issues a 2.5s lease. The Engine enforces the same absolute
      // expiry locally and, because it began counting at mint time (which
      // precedes the upgrade), deterministically wins the expiry race.
      const engine = await startEngine(baseUrl, { fixture: root });
      try {
        await waitForEvent(events, "Reach session ready", 30_000);
        // No renew: the lease expires while the socket stays open.
        await waitForEvent(events, "Reach session closed", 30_000);
        const status = await (await fetch(`${baseUrl}/session/status`)).json() as { status: string; closureReason: string };
        assert.equal(status.status, "none");
        assert.equal(status.closureReason, "lease_expired");
      } finally {
        await stopEngine(engine);
      }
    }, { sessionDurationMs: 2500, logger: (message) => events.push(message) });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Rust engine enforces its idle timeout and recovers to heartbeat", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "reach-idle-"));
  await fs.writeFile(join(root, "note.txt"), "x\n");
  const events: string[] = [];
  try {
    await withGateway(async (baseUrl) => {
      await fetch(`${baseUrl}/session/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const engine = await startEngine(baseUrl, { fixture: root }, { REACH_IDLE_SECS: "1" });
      try {
        await waitForEvent(events, "Reach session ready", 30_000);
        await waitForEvent(events, "Reach session closed", 30_000);
        const status = await (await fetch(`${baseUrl}/session/status`)).json() as { status: string; closureReason: string };
        assert.equal(status.status, "none");
        assert.equal(status.closureReason, "idle_timeout");
        // The engine keeps heartbeating: a fresh open works.
        await fetch(`${baseUrl}/session/open`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        const heartbeat = await fetch(`${baseUrl}/heartbeat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ device: { id: "reach-engine" } }),
        });
        const payload = await heartbeat.json() as { endpoint?: string; token?: string };
        assert.ok(payload.token && payload.endpoint === "/session");
      } finally {
        await stopEngine(engine);
      }
    }, { logger: (message) => events.push(message) });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Rust engine drains a session at its rotation limit", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "reach-rotation-"));
  await fs.writeFile(join(root, "note.txt"), "x\n");
  const events: string[] = [];
  try {
    await withGateway(async (baseUrl) => {
      await fetch(`${baseUrl}/session/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const engine = await startEngine(baseUrl, { fixture: root }, { REACH_ROTATION_SECS: "1" });
      try {
        await waitForEvent(events, "Reach session ready", 30_000);
        await waitForEvent(events, "Reach session closed", 30_000);
        const status = await (await fetch(`${baseUrl}/session/status`)).json() as { status: string; closureReason: string };
        assert.equal(status.status, "none");
        assert.equal(status.closureReason, "rotation");
      } finally {
        await stopEngine(engine);
      }
    }, { logger: (message) => events.push(message) });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("engine websocket failure clears the session and a new open recovers", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "reach-ws-failure-"));
  await fs.writeFile(join(root, "note.txt"), "x\n");
  const events: string[] = [];
  try {
    await withGateway(async (baseUrl) => {
      await fetch(`${baseUrl}/session/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const engine = await startEngine(baseUrl, { fixture: root });
      try {
        await waitForEvent(events, "Reach session ready", 30_000);
      } finally {
        // Kill the engine: the WebSocket drops without an explicit close.
        await stopEngine(engine);
      }
      await waitForEvent(events, "Reach session closed", 15_000);
      const status = await (await fetch(`${baseUrl}/session/status`)).json() as { status: string; closureReason: string };
      assert.equal(status.status, "none");
      assert.equal(status.closureReason, "disconnected");

      // Clean heartbeat recovery: a new open + fresh engine session works.
      await fetch(`${baseUrl}/session/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const engine2 = await startEngine(baseUrl, { fixture: root });
      try {
        await waitForEvent(events, "Reach session closed", 30_000).catch(() => undefined);
        const heartbeat = await fetch(`${baseUrl}/heartbeat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ device: { id: "reach-engine" } }),
        });
        const payload = await heartbeat.json() as { endpoint?: string; token?: string };
        assert.ok(payload.token && payload.endpoint === "/session");
      } finally {
        await stopEngine(engine2);
      }
    }, { logger: (message) => events.push(message) });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function ensureEngineBinary(): Promise<string> {
  const binary = join(repositoryRoot, "target/debug/engine");
  await new Promise<void>((resolve, reject) => {
    const build = spawn("cargo", ["build", "--quiet", "-p", "reach-rpc", "--bin", "engine"], {
      cwd: repositoryRoot,
    });
    let errors = "";
    build.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString();
    });
    build.once("error", reject);
    build.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`cargo build --bin engine failed (${code}): ${errors}`));
    });
  });
  return binary;
}

async function startEngine(
  baseUrl: string,
  roots: Record<string, string>,
  extraEnv: Record<string, string> = {},
): Promise<ChildProcess> {
  const binary = await ensureEngineBinary();
  const mapped = Object.entries(roots).map(([name, path]) => `${name}:${path}`).join(",");
  const child = spawn(binary, [baseUrl], {
    cwd: repositoryRoot,
    env: { ...process.env, REACH_WORKSPACE_ROOTS: mapped, ...extraEnv },
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  await new Promise<void>((resolve, reject) => {
    const onExit = (code: number | null) => {
      reject(new Error(`engine exited early (${code}): ${output}`));
    };
    child.once("error", reject);
    child.once("exit", onExit);
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve();
    }, 200);
    // If stdout shows the heartbeat banner, we can proceed immediately.
    child.stdout?.once("data", () => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve();
    });
  });
  (child as ChildProcess & { reachOutput?: () => string }).reachOutput = () => output;
  return child;
}

async function stopEngine(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await once(child, "exit").catch(() => undefined);
}

async function waitForEvent(events: string[], target: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!events.includes(target)) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${target}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
