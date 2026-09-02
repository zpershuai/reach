import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
} from "./gateway.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

function runSessionClient(baseUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const engine = spawn(
      "cargo",
      ["run", "--quiet", "--bin", "session-client", "--", baseUrl],
      { cwd: repositoryRoot },
    );
    let output = "";
    let errors = "";
    engine.stdout.on("data", (chunk: Buffer) => { output += chunk; });
    engine.stderr.on("data", (chunk: Buffer) => { errors += chunk; });
    engine.once("error", reject);
    engine.once("close", (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`session client exited ${code}: ${errors}`));
      }
    });
  });
}

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

function nextJson(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try { resolve(JSON.parse(data.toString()) as Record<string, unknown>); } catch (error) { reject(error); }
    });
    socket.once("error", reject);
  });
}

function request(sessionId: string, requestId: string, method: string, params: unknown, permission?: unknown): Record<string, unknown> {
  return { type: "request", protocol: "reach-rpc", version: "1.0", sessionId, requestId, method, params, ...(permission === undefined ? {} : { permission }) };
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

test("session credentials are consumed once and require an explicit re-request", async () => {
  await withGateway(async (baseUrl) => {
    const heartbeat = async (): Promise<{ wssUrl?: string; token?: string }> => {
      const response = await fetch(`${baseUrl}/heartbeat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device: { id: "engine-1" } }) });
      return response.json() as Promise<{ wssUrl?: string; token?: string }>;
    };
    await fetch(`${baseUrl}/session-wanted`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wanted: true }) });
    const first = await heartbeat();
    assert.ok(first.token && first.wssUrl);
    const engine = new WebSocket(`${first.wssUrl}?token=${first.token}`);
    await once(engine, "open");

    await new Promise<void>((resolve) => {
      const concurrent = new WebSocket(`${first.wssUrl}?token=${first.token}`);
      concurrent.once("unexpected-response", (_request, response) => { response.resume(); resolve(); });
      concurrent.once("error", resolve);
    });
    engine.close();
    await once(engine, "close");
    assert.deepEqual(await heartbeat(), { intervalSeconds: DEFAULT_HEARTBEAT_INTERVAL_SECONDS });

    await fetch(`${baseUrl}/session-wanted`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wanted: true }) });
    const renewed = await heartbeat();
    assert.ok(renewed.token);
    assert.notEqual(renewed.token, first.token);
  });
});

test("gateway rejects oversized HTTP bodies and closes oversized, idle, and hard-lived sessions", async () => {
  await withGateway(async (baseUrl) => {
    const oversized = await fetch(`${baseUrl}/heartbeat`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ device: { payload: "x".repeat(MAX_HTTP_BODY_BYTES) } }),
    });
    assert.equal(oversized.status, 413);

    const openSession = async (): Promise<WebSocket> => {
      await fetch(`${baseUrl}/session-wanted`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wanted: true }) });
      const heartbeat = await fetch(`${baseUrl}/heartbeat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device: {} }) });
      const session = await heartbeat.json() as { wssUrl: string; token: string; sessionId: string };
      const socket = new WebSocket(`${session.wssUrl}?token=${session.token}`);
      await once(socket, "open");
      return socket;
    };
    const oversizedSocket = await openSession();
    oversizedSocket.send("x".repeat(MAX_WEBSOCKET_TEXT_BYTES + 1));
    const [oversizedCode] = await once(oversizedSocket, "close") as [number];
    assert.equal(oversizedCode, 1009);

    const idleSocket = await openSession();
    const [idleCode] = await once(idleSocket, "close") as [number];
    assert.equal(idleCode, 1008);
  }, { sessionIdleMs: 20, sessionDurationMs: 100 });

  await withGateway(async (baseUrl) => {
    await fetch(`${baseUrl}/session-wanted`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wanted: true }) });
    const heartbeat = await fetch(`${baseUrl}/heartbeat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device: {} }) });
    const session = await heartbeat.json() as { wssUrl: string; token: string };
    const socket = new WebSocket(`${session.wssUrl}?token=${session.token}`);
    await once(socket, "open");
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

test("Rust engine connects once and gateway closes it after job completion", async () => {
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

    const engineOutput = await runSessionClient(baseUrl);
    await sessionClosed;
    assert.match(engineOutput, /Reach engine session connected/);
    assert.match(engineOutput, /Reach engine session closed/);
    assert.deepEqual(events, [
      "Reach session connected",
      "Reach session job done",
      "Reach session closed",
    ]);
  }, {
    logger: (message) => {
      events.push(message);
      if (message === "Reach session closed") {
        resolveSessionClosed();
      }
    },
  });
});

test("session dispatches filesystem methods directly and through tool.call", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "reach-gateway-workspace-"));
  await fs.writeFile(join(root, "note.txt"), "hello\nworld\n");
  try {
    await withGateway(async (baseUrl) => {
      await fetch(`${baseUrl}/session-wanted`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wanted: true }) });
      const heartbeat = await fetch(`${baseUrl}/heartbeat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device: { id: "engine-1" } }) });
      const session = await heartbeat.json() as { wssUrl: string; token: string; sessionId: string };
      const engine = new WebSocket(`${session.wssUrl}?token=${session.token}`);
      await once(engine, "open");

      engine.send(JSON.stringify(request(session.sessionId, "direct", "fs.read", { workspace: "fixture", path: "note.txt", maxLines: 1 })));
      const direct = await nextJson(engine);
      assert.deepEqual(direct, { type: "response", requestId: "direct", result: { content: "hello", startLine: 1, endLine: 1, totalLines: 2, truncated: true, revision: (direct.result as { revision: string }).revision } });

      engine.send(JSON.stringify(request(session.sessionId, "tool", "tool.call", { name: "fs.read", arguments: { workspace: "fixture", path: "note.txt", startLine: 2 } })));
      const tool = await nextJson(engine);
      assert.equal((tool.result as { content: string }).content, "world");

      const issued = await fetch(`${baseUrl}/grants`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace: "fixture", path: "note.txt", methods: ["fs.write"] }) });
      const grant = await issued.json() as { grantId: string };
      engine.send(JSON.stringify(request(session.sessionId, "write", "fs.write", { workspace: "fixture", path: "note.txt", content: "changed", mode: "overwrite" }, { grantId: grant.grantId })));
      assert.equal((await nextJson(engine)).type, "response");
      assert.equal(await fs.readFile(join(root, "note.txt"), "utf8"), "changed");
      engine.send(JSON.stringify({ type: "job.done" }));
      await once(engine, "close");
    }, { workspaceRoots: { fixture: root } });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("gateway-issued grants authorize only their live scoped mutations", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "reach-gateway-grants-"));
  await fs.writeFile(join(root, "note.txt"), "unchanged");
  try {
    await withGateway(async (baseUrl) => {
      await fetch(`${baseUrl}/session-wanted`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wanted: true }) });
      const heartbeat = await fetch(`${baseUrl}/heartbeat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device: { id: "engine-1" } }) });
      const session = await heartbeat.json() as { wssUrl: string; token: string; sessionId: string };
      const engine = new WebSocket(`${session.wssUrl}?token=${session.token}`);
      await once(engine, "open");

      const issued = await fetch(`${baseUrl}/grants`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace: "fixture", path: "note.txt", methods: ["fs.write"] }),
      });
      assert.equal(issued.status, 200);
      const grant = await issued.json() as { grantId: string; expiresAt: string };
      assert.match(grant.grantId, /^[0-9a-f-]{36}$/);
      assert.ok(Date.parse(grant.expiresAt) > Date.now());

      for (const permission of [{ grantId: "forged" }, { grantId: grant.grantId }]) {
        engine.send(JSON.stringify(request(session.sessionId, permission.grantId, "fs.write", { workspace: permission.grantId === "forged" ? "fixture" : "other", path: "note.txt", content: "changed", mode: "overwrite" }, permission)));
        const reply = await nextJson(engine);
        assert.equal((reply.error as { code: string }).code, "PERMISSION_DENIED");
      }
      assert.equal(await fs.readFile(join(root, "note.txt"), "utf8"), "unchanged");

      engine.send(JSON.stringify(request(session.sessionId, "allowed", "fs.write", { workspace: "fixture", path: "note.txt", content: "changed", mode: "overwrite" }, { grantId: grant.grantId })));
      assert.equal((await nextJson(engine)).type, "response");
      assert.equal(await fs.readFile(join(root, "note.txt"), "utf8"), "changed");
      engine.close();
      await once(engine, "close");
    }, { workspaceRoots: { fixture: root } });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("gateway rejects malformed, wrong-version, and mismatched-session envelopes", async () => {
  await withGateway(async (baseUrl) => {
    await fetch(`${baseUrl}/session-wanted`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wanted: true }) });
    const heartbeat = await fetch(`${baseUrl}/heartbeat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device: {} }) });
    const session = await heartbeat.json() as { wssUrl: string; token: string; sessionId: string };
    const engine = new WebSocket(`${session.wssUrl}?token=${session.token}`);
    await once(engine, "open");
    for (const payload of [
      { type: "request", method: "fs.read", params: {} },
      { ...request(session.sessionId, "wrong-version", "fs.read", { workspace: "default", path: "x" }), version: "2.0" },
      request("other-session", "wrong-session", "fs.read", { workspace: "default", path: "x" }),
    ]) {
      engine.send(JSON.stringify(payload));
      const reply = await nextJson(engine);
      assert.equal((reply.error as { code: string }).code, "INVALID_PARAMS");
    }
    engine.close();
    await once(engine, "close");
  });
});
