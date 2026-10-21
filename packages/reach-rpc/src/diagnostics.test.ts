import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { createGateway } from "./gateway.js";
import { attachHttpDiagnostics, diagnosticCode, diagnosticRoute } from "./diagnostics.js";
import { ConsoleStore } from "./console-api/store.js";

test("HTTP diagnostics allow only known routes, excluding tokens, path segments and query strings", () => {
  for (const target of ["/private-credential?token=secret", "/private-credential", "http://user:secret@example.com/private-credential", "/%0aSECRET"]) assert.equal(diagnosticRoute(target), "/unknown");
  assert.equal(diagnosticRoute("/session/status?token=secret"), "/session/status");
  assert.equal(diagnosticRoute("/api/console/access-clients/secret-id"), "/api/console/*");
});

test("Gateway HTTP, lifecycle and audit keep payloads and upstream error echoes out of diagnostics", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reach-diagnostic-boundary-"));
  const logs: string[] = [];
  const controller = "c".repeat(48), engineToken = "e".repeat(48);
  const sentinels = ["private-credential-sentinel", "private-body-sentinel", "private-args-sentinel", "private-output-sentinel"];
  const gateway = createGateway({ logger: line => logs.push(line), sessionRpcTimeoutMs: 80,
    authentication: { controllerToken: controller, engineToken, engineId: "engine-a" },
    console: { dataDir: directory, publicOrigin: "https://gateway.example.com", setupToken: sentinels[0], trustedProxies: [], retentionDays: 30 } });
  attachHttpDiagnostics(gateway, line => logs.push(line));
  gateway.listen(0, "127.0.0.1"); await once(gateway, "listening");
  const address = gateway.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body: unknown, token = controller) => fetch(base + path, { method: "POST", headers: { authorization: `Bearer ${token}`, cookie: sentinels[0], "content-type": "application/json" }, body: JSON.stringify(body) });
  let socket: WebSocket | undefined;
  try {
    await post(`/unknown/${sentinels[0]}?token=${sentinels[0]}`, { content: sentinels[1] });
    await post(`/session/open?token=${sentinels[0]}`, {});
    const lease = await (await post("/heartbeat", { device: { id: "engine-a" } }, engineToken)).json() as any;
    socket = new WebSocket(`${base.replace("http:", "ws:")}${lease.endpoint}?token=${lease.token}`);
    await once(socket, "open");
    socket.on("message", data => {
      const request = JSON.parse(data.toString());
      if (request.type !== "request" || request.params.path === "timeout") return;
      socket!.send(JSON.stringify({ type: request.params.path === "echo" ? "error" : "response", requestId: request.requestId,
        ...(request.params.path === "echo" ? { error: { code: sentinels[0] + "\nFORGED_LOG" } } : { result: { content: sentinels[1], revision: "a".repeat(64) } }) }));
    });
    socket.send(JSON.stringify({ type: "session.ready", protocol: "reach-rpc", version: "1.0", sessionId: lease.sessionId, engineId: "engine-a", workspaces: ["docs"], methods: ["fs.read"] }));
    for (let n = 0; n < 100 && (await (await post("/session/status", {})).json() as any).status !== "ready"; n++) await delay(5);
    for (const path of ["echo", "ok", "timeout"]) {
      const response = await (await post("/session/rpc", { requestId: `diagnostic-${path}`, method: "fs.read", params: { workspace: "docs", path, args: [sentinels[2]] } })).json() as any;
      if (path === "ok") assert.equal(response.result.content, sentinels[1], "authorized payload remains application data");
    }
    gateway.events!.emit("rpc.denied", { caller: { type: "controller", label: "forged\n" + "x".repeat(1000), verified: false, principalId: "controller" },
      method: "fs.read", path: "x\n" + "y".repeat(10000), code: sentinels[0],
      ...({ content: sentinels[1], args: [sentinels[2]], output: sentinels[3], authorization: sentinels[0] } as any) });
    gateway.audit!.flush();
    const store = new ConsoleStore(directory);
    try {
      const rows = store.db.prepare("SELECT * FROM activity").all();
      const audit = JSON.stringify(rows);
      for (const sentinel of [...sentinels, controller, engineToken, lease.token]) assert.ok(!audit.includes(sentinel) && !logs.join("\n").includes(sentinel));
      assert.ok(rows.some(row => row.principal_id === "controller"));
      assert.ok(rows.some(row => row.code === "UPSTREAM_ERROR"));
      assert.ok(rows.every(row => !String(row.client_label ?? "").includes("\n") && String(row.path ?? "").length <= 1024));
      assert.ok(logs.every(line => line.length < 512 && !line.includes("\n")));
    } finally { store.close(); }
  } finally {
    socket?.terminate(); await new Promise<void>(resolve => gateway.close(() => resolve())); rmSync(directory, { recursive: true, force: true });
  }
});

test("every error code the Engine can put on the wire survives audit diagnostics", () => {
  const sources = new URL("../../../crates/reach-rpc/src/", import.meta.url);
  const files = readdirSync(sources, { recursive: true, encoding: "utf8" }).filter(name => name.endsWith(".rs") && !name.endsWith("tests.rs"));
  const emitted = new Set<string>();
  for (const name of files) {
    const text = readFileSync(new URL(name, sources), "utf8").split("#[cfg(test)]")[0]!;
    for (const pattern of [/(?:Filesystem|Tool)Error::new\("([A-Z][A-Z0-9_]+)"\)/g, /"code": "([A-Z][A-Z0-9_]+)"/g, /pub const ([A-Z][A-Z0-9_]+): &str = "\1";/g, /Err\("(INTERNAL_ERROR)"\.into\(\)\)/g]) {
      for (const match of text.matchAll(pattern)) emitted.add(match[1]!);
    }
  }
  for (const code of ["FILE_EXISTS", "TOO_MANY_REQUESTS", "INTERNAL_ERROR"]) assert.ok(emitted.has(code), `scanner must find ${code}`);
  for (const code of emitted) assert.equal(diagnosticCode(code), code, `${code} must not be rewritten to UPSTREAM_ERROR`);
  assert.equal(diagnosticCode("A free-form upstream message"), "UPSTREAM_ERROR");
});
