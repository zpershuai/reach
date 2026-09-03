import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
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

async function openEngineSession(baseUrl: string): Promise<{ socket: WebSocket; sessionId: string; wssUrl: string; token: string }> {
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
  const session = await heartbeat.json() as { wssUrl: string; token: string; sessionId: string };
  const socket = new WebSocket(`${session.wssUrl}?token=${session.token}`);
  await once(socket, "open");
  return { socket, ...session };
}

/** Minimal Model B engine peer: answers Gateway-forwarded requests and can emit job.done. */
function attachMockEngine(socket: WebSocket, handler?: (envelope: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>): void {
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
      sessionId: string;
    };
    assert.equal(payload.intervalSeconds, SESSION_WANTED_HEARTBEAT_INTERVAL_SECONDS);
    assert.match(payload.token, /^[0-9a-f-]{36}$/);
    assert.match(payload.sessionId, /^[0-9a-f-]{36}$/);
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

test("session credentials are consumed once and require an explicit re-request", async () => {
  await withGateway(async (baseUrl) => {
    const heartbeat = async (): Promise<{ wssUrl?: string; token?: string; intervalSeconds?: number }> => {
      const response = await fetch(`${baseUrl}/heartbeat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device: { id: "engine-1" } }),
      });
      return response.json() as Promise<{ wssUrl?: string; token?: string; intervalSeconds?: number }>;
    };
    await fetch(`${baseUrl}/session-wanted`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wanted: true }),
    });
    const first = await heartbeat();
    assert.ok(first.token && first.wssUrl);
    const engine = new WebSocket(`${first.wssUrl}?token=${first.token}`);
    await once(engine, "open");

    await new Promise<void>((resolve) => {
      const concurrent = new WebSocket(`${first.wssUrl}?token=${first.token}`);
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
    const session = await heartbeat.json() as { wssUrl: string; token: string };
    const url = new URL(session.wssUrl);

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
    const payload = await renewed.json() as { token?: string; wssUrl?: string; intervalSeconds: number };
    assert.equal(payload.intervalSeconds, SESSION_WANTED_HEARTBEAT_INTERVAL_SECONDS);
    assert.ok(payload.token && payload.wssUrl);

    const socket = new WebSocket(`${payload.wssUrl}?token=${payload.token}`);
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

test("Rust engine service connects, serves workspace RPC, and completes via session.complete", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "reach-model-b-"));
  await fs.writeFile(join(root, "note.txt"), "hello\nworld\n");
  const events: string[] = [];
  let resolveSessionClosed: () => void = () => {};
  const sessionClosed = new Promise<void>((resolve) => {
    resolveSessionClosed = resolve;
  });

  try {
    await withGateway(async (baseUrl) => {
      await fetch(`${baseUrl}/session-wanted`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wanted: true }),
      });

      const engine = await startEngine(baseUrl, { fixture: root });
      try {
        try {
          await waitForEvent(events, "Reach session connected", 30_000);
        } catch (error) {
          const output = (engine as ChildProcess & { reachOutput?: () => string }).reachOutput?.() ?? "";
          throw new Error(`${error instanceof Error ? error.message : error}\nengine output:\n${output}`);
        }

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

        const nested = await fetch(`${baseUrl}/session/rpc`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(rpcBody("nested-1", "tool.call", {
            name: "tool.call",
            arguments: {
              name: "fs.write",
              arguments: { workspace: "fixture", path: "note.txt", content: "nested", mode: "overwrite" },
            },
          }, { grantId: grant.grantId })),
        });
        assert.equal((await nested.json() as { error: { code: string } }).error.code, "INVALID_PARAMS");
        assert.equal(await fs.readFile(join(root, "note.txt"), "utf8"), "hello\nworld\n");

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

        const complete = await fetch(`${baseUrl}/session/rpc`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(rpcBody("done-1", "session.complete", {})),
        });
        assert.equal((await complete.json() as { type: string }).type, "response");
        await sessionClosed;
        assert.deepEqual(events, [
          "Reach session connected",
          "Reach session job done",
          "Reach session closed",
        ]);
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

async function startEngine(baseUrl: string, roots: Record<string, string>): Promise<ChildProcess> {
  const binary = await ensureEngineBinary();
  const mapped = Object.entries(roots).map(([name, path]) => `${name}:${path}`).join(",");
  const child = spawn(binary, [baseUrl], {
    cwd: repositoryRoot,
    env: { ...process.env, REACH_WORKSPACE_ROOTS: mapped },
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
