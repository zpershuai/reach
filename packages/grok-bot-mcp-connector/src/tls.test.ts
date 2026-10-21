import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("Connector HTTPS verifies trust, expiry and hostname before sending client credentials", { timeout: 20_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "reach-connector-tls-"));
  const secret = "private-client-credential-sentinel";
  try {
    execFileSync("python3", [fileURLToPath(new URL("../../../scripts/tls-test-fixture.py", import.meta.url)), directory]);
    for (const certificate of ["trusted", "untrusted", "expired", "wrong-host", "default-roots"] as const) {
      const requests: string[] = [];
      const server = createServer({ key: readFileSync(join(directory, "leaf.key")), cert: readFileSync(join(directory, `${certificate === "default-roots" ? "trusted" : certificate}.crt`)) }, (request, response) => {
        requests.push(request.headers.authorization ?? ""); response.writeHead(200, { "content-type": "application/json" }); response.end('{"status":"none"}');
      });
      server.on("tlsClientError", () => {});
      server.listen(0, "127.0.0.1"); await once(server, "listening");
      const address = server.address(); assert.ok(address && typeof address === "object");
      try {
        const module = new URL("./gateway.js", import.meta.url).href;
        const program = `import { HttpGatewayClient } from ${JSON.stringify(module)}; const client = new HttpGatewayClient({id:'fixture',gatewayUrl:process.argv[1],controllerToken:process.argv[2]},1000,5); try { const result = await client.status(); process.stdout.write(result.status); } catch { process.stdout.write('TLS_REJECTED'); }`;
        const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: directory };
        if (certificate !== "default-roots") env.NODE_EXTRA_CA_CERTS = join(directory, "ca.crt");
        const child = spawn(process.execPath, ["--input-type=module", "-e", program, `https://127.0.0.1:${address.port}`, secret], { env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "", stderr = "";
        child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
        const timeout = setTimeout(() => child.kill("SIGKILL"), 5000); timeout.unref();
        const [code] = await once(child, "exit"); clearTimeout(timeout); assert.equal(code, 0, stderr);
        assert.ok(!stdout.includes(secret) && !stderr.includes(secret));
        if (certificate === "trusted") { assert.equal(stdout, "none"); assert.deepEqual(requests, [`Bearer ${secret}`]); }
        else { assert.equal(stdout, "TLS_REJECTED"); assert.deepEqual(requests, [], "TLS failure must precede credential-bearing application bytes"); }
      } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
