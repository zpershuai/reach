import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type RequestListener } from "node:http";
import type { Socket } from "node:net";
import test from "node:test";
import { HttpGatewayClient } from "./gateway.js";
import { loadConfig } from "./config.js";

async function withHttp(handler: RequestListener, check: (url: string) => Promise<void>): Promise<void> {
  const sockets = new Set<Socket>();
  const server = createServer(handler);
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  try { await check(`http://127.0.0.1:${address.port}`); }
  finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("default readiness budget includes idle heartbeat and connection setup", () => {
  assert.equal(loadConfig({}).readyTimeoutMs, 150_000);
});

test("HTTP status preserves component versions and tolerates unversioned peers", async () => {
  let reply: Record<string, unknown> = { status: "none", gatewayVersion: "2.0.0", engineVersion: "1.2.3" };
  const client = new HttpGatewayClient({ id: "mac", gatewayUrl: "https://reach.example" }, 1000, 1, async () => new Response(JSON.stringify(reply)));
  assert.equal((await client.status()).gatewayVersion, "2.0.0");
  assert.equal((await client.status()).engineVersion, "1.2.3");
  reply = { status: "none", engineVersion: null };
  assert.equal((await client.status()).gatewayVersion, undefined);
  assert.equal((await client.status()).engineVersion, undefined);
});

test("status retries transient transport failures but not authentication rejection", async () => {
  let requests = 0;
  const client = new HttpGatewayClient({ id: "mac", gatewayUrl: "https://reach.example" }, 1000, 1, async (_url, init) => {
    assert.equal(init?.method, "POST");
    requests++;
    if (requests === 1) throw new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
    return new Response(JSON.stringify({ status: "none" }), { status: 200 });
  }, 1000);
  assert.equal((await client.status()).status, "none");
  assert.equal(requests, 2);
  requests = 0;
  const unauthorized = new HttpGatewayClient({ id: "mac", gatewayUrl: "https://reach.example" }, 1000, 1, async () => {
    requests++;
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }, 1000);
  await assert.rejects(unauthorized.status(), /unauthorized/);
  assert.equal(requests, 1);
});

test("readiness tolerates a lost status response without replaying session open", async () => {
  let sessionId = "";
  let opens = 0;
  let polls = 0;
  const client = new HttpGatewayClient({ id: "mac", gatewayUrl: "https://reach.example" }, 1000, 1, async (url, init) => {
    if (url.endsWith("/session/open")) {
      opens++;
      sessionId = JSON.parse(init?.body as string).sessionId;
      return new Response(JSON.stringify({ sessionId }));
    }
    assert.ok(url.endsWith("/session/status"));
    polls++;
    if (polls === 1) throw new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
    return new Response(JSON.stringify({ status: "ready", sessionId }));
  }, 1000);
  assert.equal((await client.openAndWait()).sessionId, sessionId);
  assert.equal(opens, 1);
  assert.equal(polls, 2);
});

test("Connector loads private device credentials from a config file", () => {
  const directory = mkdtempSync(join(tmpdir(), "reach-config-"));
  const path = join(directory, "devices.json");
  const device = { id: "mac", gatewayUrl: "https://reach.example", controllerToken: "c".repeat(48) };
  try {
    writeFileSync(path, JSON.stringify([device]), { mode: 0o600 });
    assert.deepEqual(loadConfig({ REACH_MCP_DEVICES_FILE: path }).devices, [device]);
    assert.throws(() => loadConfig({ REACH_MCP_DEVICES_FILE: path, REACH_MCP_DEVICES: "[]" }));
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("Connector authenticates status and refuses redirects that could leak credentials", async () => {
  const controllerToken = "c".repeat(48);
  await withHttp((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${controllerToken}`);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "none" }));
  }, async (gatewayUrl) => {
    const client = new HttpGatewayClient({ id: "mac", gatewayUrl, controllerToken }, 1000, 10);
    assert.equal((await client.status()).status, "none");
  });
  await withHttp((_request, response) => {
    response.writeHead(302, { location: "http://127.0.0.1:1/credential-leak" });
    response.end();
  }, async (gatewayUrl) => {
    const client = new HttpGatewayClient({ id: "mac", gatewayUrl, controllerToken }, 1000, 10);
    await assert.rejects(client.status());
  });
});

test("readiness timeout clears the same pending session intent", async () => {
  let status = "none";
  let sessionId: string | undefined;
  let closes = 0;
  await withHttp(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const params = body ? JSON.parse(body) as { sessionId?: string } : {};
    if (request.url === "/session/open") { sessionId = params.sessionId; status = "wanted"; }
    if (request.url === "/session/close") {
      assert.equal(params.sessionId, sessionId);
      closes += 1;
      status = "none";
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status, sessionId }));
  }, async (gatewayUrl) => {
    const client = new HttpGatewayClient({ id: "test", gatewayUrl }, 30, 5, fetch, 100);
    await assert.rejects(client.openAndWait(), /did not become ready/);
    assert.equal(closes, 1);
    assert.equal(status, "none");
  });
});

test("HTTP headers and response bodies have a request timeout", async () => {
  for (const sendHeaders of [false, true]) {
    await withHttp((_request, response) => {
      if (sendHeaders) { response.writeHead(200, { "content-type": "application/json" }); response.write('{"status":'); }
    }, async (gatewayUrl) => {
      const client = new HttpGatewayClient({ id: "test", gatewayUrl }, 100, 5, fetch, 25);
      await assert.rejects(client.status());
    });
  }
});

test("a lost open response still clears the accepted session intent", async () => {
  let status = "none";
  let sessionId: string | undefined;
  let closes = 0;
  await withHttp(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const params = body ? JSON.parse(body) as { sessionId?: string } : {};
    if (request.url === "/session/open") {
      sessionId = params.sessionId;
      status = "wanted";
      response.destroy();
      return;
    }
    if (request.url === "/session/close") {
      assert.equal(params.sessionId, sessionId);
      closes += 1;
      status = "none";
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status, sessionId }));
  }, async (gatewayUrl) => {
    const client = new HttpGatewayClient({ id: "test", gatewayUrl }, 100, 5, fetch, 100);
    await assert.rejects(client.openAndWait());
    assert.equal(closes, 1);
    assert.equal(status, "none");
  });
});

test("closing a replaced session cannot close the replacement", async () => {
  let sessionId: string | undefined;
  let replaced = false;
  let closes = 0;
  await withHttp(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.url === "/session/open") sessionId = (JSON.parse(body) as { sessionId: string }).sessionId;
    if (request.url === "/session/close") closes += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ready", sessionId: replaced ? "other-session" : sessionId }));
  }, async (gatewayUrl) => {
    const client = new HttpGatewayClient({ id: "test", gatewayUrl }, 100, 5);
    await client.openAndWait();
    replaced = true;
    await assert.rejects(client.close(), /replaced/);
    assert.equal(closes, 0);
  });
});

test("legacy Gateway ids are adopted once after heartbeat acquisition", async () => {
  let polls = 0;
  const boundIds: string[] = [];
  await withHttp(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    let reply: Record<string, unknown> = {};
    if (request.url === "/session/open") reply = { wanted: true, status: "wanted" };
    if (request.url === "/session/status") {
      polls += 1;
      reply = polls === 1 ? { status: "wanted" } : { status: "ready", sessionId: "legacy-id" };
    }
    if (request.url === "/session/rpc" || request.url === "/session/renew") {
      boundIds.push((JSON.parse(body) as { sessionId: string }).sessionId);
      reply = { leaseExpiresAt: new Date(Date.now() + 300_000).toISOString() };
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(reply));
  }, async (gatewayUrl) => {
    const client = new HttpGatewayClient({ id: "test", gatewayUrl }, 500, 5);
    assert.equal((await client.openAndWait()).sessionId, "legacy-id");
    await client.rpc("fs.read", {});
    assert.equal((await client.renew()).sessionId, "legacy-id");
    assert.deepEqual(boundIds, ["legacy-id", "legacy-id"]);
  });
});

test("an acknowledged intent cannot adopt a different first status id", async () => {
  let sessionId: string | undefined;
  let closes = 0;
  await withHttp(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.url === "/session/open") sessionId = (JSON.parse(body) as { sessionId: string }).sessionId;
    if (request.url === "/session/close") closes += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url === "/session/open"
      ? { status: "wanted", sessionId }
      : { status: "ready", sessionId: "other-owner" }));
  }, async (gatewayUrl) => {
    const client = new HttpGatewayClient({ id: "test", gatewayUrl }, 100, 5);
    await assert.rejects(client.openAndWait(), /replaced/);
    assert.equal(closes, 0);
  });
});

test("a missing active id is uncertain and does not erase the owned binding", async () => {
  let sessionId: string | undefined;
  let missingId = false;
  let closed = false;
  let closes = 0;
  await withHttp(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.url === "/session/open") sessionId = (JSON.parse(body) as { sessionId: string }).sessionId;
    if (request.url === "/session/close") {
      assert.equal((JSON.parse(body) as { sessionId: string }).sessionId, sessionId);
      closes += 1;
      closed = true;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: closed ? "none" : "ready", ...(missingId ? {} : { sessionId }) }));
  }, async (gatewayUrl) => {
    const client = new HttpGatewayClient({ id: "test", gatewayUrl }, 100, 5);
    await client.openAndWait();
    missingId = true;
    await assert.rejects(client.close(), /no session id/);
    assert.equal(closes, 0);
    missingId = false;
    await client.close();
    assert.equal(closes, 1);
  });
});
