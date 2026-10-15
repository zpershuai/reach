import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { serveConsole } from "./static.js";

test("console static serving protects paths, sets security and cache headers, and supports deep links", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reach-static-"));
  const assets = join(directory, "console");
  mkdirSync(join(assets, "assets"), { recursive: true });
  writeFileSync(join(assets, "index.html"), "<!doctype html><title>Reach</title>");
  writeFileSync(join(assets, "assets/app-abcd1234.js"), "export const version=1;");
  writeFileSync(join(directory, "outside.txt"), "private");
  symlinkSync(join(directory, "outside.txt"), join(assets, "escape.txt"));
  const server = createServer((request, response) => { void serveConsole(request, response, assets); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const path of ["/console/", "/console/devices/nas-01"]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-cache");
      const csp = response.headers.get("content-security-policy")!;
      for (const directive of ["default-src 'self'", "script-src 'self'", "frame-ancestors 'none'", "object-src 'none'"]) assert.ok(csp.includes(directive));
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.ok((await response.text()).includes("<title>Reach</title>"));
    }
    const hashed = await fetch(`${base}/console/assets/app-abcd1234.js`);
    assert.equal(hashed.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.ok((await hashed.text()).includes("export const"));
    const traversal = await new Promise<number>((resolve, reject) => {
      const req = request(base, { path: "/console/../package.json" }, response => { response.resume(); resolve(response.statusCode!); });
      req.on("error", reject); req.end();
    });
    assert.equal(traversal, 403);
    assert.equal((await fetch(`${base}/console/escape.txt`)).status, 403);
    rmSync(join(assets, "index.html"));
    const missing = await fetch(`${base}/console/`);
    assert.equal(missing.status, 503);
    assert.ok((await missing.text()).includes("build packages/gateway-console"));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});
