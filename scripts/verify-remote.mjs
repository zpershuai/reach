import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { HttpGatewayClient } from "../packages/grok-bot-mcp-connector/dist/gateway.js";

const config = JSON.parse(await readFile(process.argv[2] ?? ".reach/deployment.json", "utf8"));
const results = [];
async function check(name, action) {
  await action();
  results.push({ name, passed: true });
  console.log(`PASS ${name}`);
}
const request = (path, token, body) => fetch(`${config.gatewayUrl}${path}`, {
  method: body === undefined ? "GET" : "POST",
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  signal: AbortSignal.timeout(35000), redirect: "error",
});
const client = new HttpGatewayClient({ id: config.engineId, gatewayUrl: config.gatewayUrl, controllerToken: config.controllerToken }, 60000, 250);
async function expectStatus(path, token, body, expected) {
  const response = await request(path, token, body);
  await response.arrayBuffer();
  assert.equal(response.status, expected, path);
}
await check("public HTTPS health", async () => {
  const response = await request("/healthz");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).protocol, "reach-rpc/1.0");
});
await check("unauthenticated control rejected", async () => {
  await expectStatus("/session/status", undefined, undefined, 401);
  await expectStatus("/session/open", undefined, {}, 401);
});
await check("credential roles separated", async () => {
  await expectStatus("/session/open", config.engineToken, {}, 401);
  await expectStatus("/heartbeat", config.controllerToken, { device: { id: config.engineId } }, 401);
});
await check("Engine identity bound to credential", async () => {
  await expectStatus("/heartbeat", config.engineToken, { device: { id: "unregistered-engine" } }, 403);
});
const probe = `deployment-tests/${randomUUID()}.txt`;
const content = "Reach deployment verified\nGateway VPS to Mac Engine over WSS\n";
const rpc = async (method, params, permission) => {
  const response = await client.rpc(method, { workspace: "default", ...params }, permission);
  assert.equal(response.type, "response", JSON.stringify(response));
  return response.result;
};
try {
  await check("Mac Engine ready over WSS", async () => {
    const ready = await client.openAndWait();
    assert.ok(ready.sessionId);
  });
  await check("write without grant rejected", async () => {
    const result = await client.rpc("fs.write", { workspace: "default", path: probe, content: "unauthorized", mode: "create" });
    assert.equal(result.type, "error");
    assert.equal(result.error.code, "PERMISSION_DENIED");
  });
  await check("grant write and remote read", async () => {
    const grant = await client.grant("default", probe, "fs.write");
    await rpc("fs.write", { path: probe, content, mode: "create" }, grant);
    const result = await rpc("fs.read", { path: probe });
    assert.equal(result.content, content.trimEnd());
    if (config.workspaceRoot) assert.equal(await readFile(`${config.workspaceRoot}/${probe}`, "utf8"), content);
  });
  await check("stat list glob grep", async () => {
    const stat = await rpc("fs.stat", { path: probe });
    assert.equal(stat.type, "file");
    assert.equal(stat.size, Buffer.byteLength(content));
    const list = await rpc("fs.list", { path: "deployment-tests" });
    assert.ok(list.entries.some((entry) => entry.path === probe));
    const glob = await rpc("fs.glob", { pattern: "deployment-tests/*.txt" });
    assert.ok(glob.matches.includes(probe));
    const grep = await rpc("fs.grep", { pattern: "Reach deployment verified", path: ".", include: [probe] });
    assert.ok(grep.matches.some((match) => match.path === probe));
  });
  await check("remote edit", async () => {
    const grant = await client.grant("default", probe, "fs.edit");
    await rpc("fs.edit", { path: probe, oldString: "Reach deployment verified", newString: "Reach deployment and edit verified" }, grant);
    const result = await rpc("fs.read", { path: probe });
    assert.ok(result.content.includes("Reach deployment and edit verified"));
  });
  await check("workspace escape denied", async () => {
    const response = await client.rpc("fs.read", { workspace: "default", path: "../outside.txt" });
    assert.equal(response.type, "error");
  });
  await check("renew lease", async () => { assert.ok((await client.renew()).leaseExpiresAt); });
  await check("close and reopen session", async () => {
    await client.close();
    assert.equal((await client.status()).status, "none");
    await client.openAndWait();
    assert.ok((await rpc("fs.read", { path: probe })).content.includes("edit verified"));
  });
} finally {
  await client.close();
}
await mkdir(".reach", { recursive: true });
await writeFile(".reach/remote-verification.json", JSON.stringify({ gatewayUrl: config.gatewayUrl, engineId: config.engineId, checkedAt: new Date().toISOString(), probe, results }, null, 2));
