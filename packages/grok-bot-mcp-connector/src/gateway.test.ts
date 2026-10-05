import assert from "node:assert/strict";
import { once } from "node:events";
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
