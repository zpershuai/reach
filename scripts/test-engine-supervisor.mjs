import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("./engine-supervisor.mjs", import.meta.url),
);
const digest = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

function fixture(behavior) {
  const directory = mkdtempSync(join(tmpdir(), "reach-host-update-test-"));
  const binary = join(directory, "engine"),
    previous = join(directory, "engine.prev");
  const inventory = join(directory, "versions.json");
  const compile = (path, source) =>
    execFileSync("cc", ["-x", "c", "-", "-o", path], {
      input: source,
      stdio: ["pipe", "pipe", "pipe"],
    });
  compile(
    previous,
    '#include <stdio.h>\nint main(void) { puts("PRIOR_ENGINE_STARTED"); return 0; }',
  );
  const format = JSON.stringify(
    '{"nonce":"%s","version":"1.2.3","phase":"heartbeat"}',
  );
  const health =
    behavior === "healthy"
      ? `FILE *f=fopen(getenv("REACH_UPDATE_HEALTH_FILE"),"w"); fprintf(f,${format},getenv("REACH_UPDATE_HEALTH_NONCE")); fclose(f);`
      : "";
  const finish = behavior === "exit" ? "return 1;" : "for (;;) sleep(1);";
  compile(
    binary,
    `#include <stdio.h>\n#include <stdlib.h>\n#include <unistd.h>\nint main(void) { ${health} ${finish} }`,
  );
  writeFileSync(inventory, '{"engineVersion":"1.2.3"}\n');
  const pending = join(directory, "engine.update-pending.json");
  writeFileSync(
    pending,
    JSON.stringify({
      schemaVersion: 1,
      version: "1.2.3",
      digest: digest(binary),
      previousDigest: digest(previous),
      inventory: [inventory, '{"engineVersion":"1.2.2"}\n'],
    }),
    { mode: 0o600 },
  );
  return { directory, binary, previous, inventory, pending };
}

for (const behavior of ["healthy", "exit", "timeout"]) {
  test(
    `host update ${behavior} confirms a fresh heartbeat or restores the prior binary and inventory`,
    { timeout: 10_000 },
    async () => {
      const f = fixture(behavior);
      const child = spawn(process.execPath, [script, f.binary], {
        env: {
          PATH: process.env.PATH,
          HOME: f.directory,
          REACH_SUPERVISOR_TEST_MODE: "1",
          REACH_SUPERVISOR_TEST_TIMEOUT_MS:
            behavior === "healthy" ? "5000" : "200",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (data) => {
        stdout += data;
      });
      child.stderr.on("data", (data) => {
        stderr += data;
      });
      const exit = once(child, "exit");
      try {
        if (behavior === "healthy") {
          for (
            let n = 0;
            n < 1200 && !stderr.includes("HOST_UPDATE_HEALTHY");
            n++
          )
            await delay(5);
          assert.ok(stderr.includes("HOST_UPDATE_HEALTHY"), stderr);
          assert.equal(existsSync(f.pending), false);
          assert.equal(
            JSON.parse(readFileSync(f.inventory)).engineVersion,
            "1.2.3",
          );
          child.kill("SIGTERM");
          await exit;
        } else {
          assert.equal((await exit)[0], 0);
          assert.ok(stderr.includes("HOST_UPDATE_ROLLED_BACK"));
          assert.ok(stdout.includes("PRIOR_ENGINE_STARTED"));
          assert.deepEqual(readFileSync(f.binary), readFileSync(f.previous));
          assert.equal(
            JSON.parse(readFileSync(f.inventory)).engineVersion,
            "1.2.2",
          );
          assert.equal(existsSync(f.pending), false);
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          await exit;
        }
        rmSync(f.directory, { recursive: true, force: true });
      }
    },
  );
}

test("host update corruption fails closed without executing either candidate", async () => {
  const f = fixture("exit");
  writeFileSync(f.previous, "corrupt prior artifact");
  const child = spawn(process.execPath, [script, f.binary], {
    env: { PATH: process.env.PATH, HOME: f.directory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  try {
    assert.equal((await once(child, "exit"))[0], 1);
    assert.equal(stdout, "");
    assert.match(stderr, /HOST_UPDATE_RECOVERY_REQUIRED/);
    assert.equal(existsSync(f.pending), true);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

describe("real Engine supervisor fixture", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  // A cold Rust build is setup work, not part of the heartbeat deadline.
  before(() => {
    execFileSync("cargo", ["build", "--quiet", "--locked", "-p", "reach-rpc", "--bin", "engine"], { cwd: root, timeout: 120_000 });
  }, { timeout: 125_000 });
  test("a real Engine acknowledges host-update health only after a successful heartbeat", { timeout: 20_000 }, async () => {
    const f = fixture("healthy");
    copyFileSync(join(root, "target/debug/engine"), f.binary);
    const version = execFileSync(f.binary, ["--version"], { encoding: "utf8" }).trim();
    const intent = JSON.parse(readFileSync(f.pending)); intent.version = version; intent.digest = digest(f.binary); writeFileSync(f.pending, JSON.stringify(intent));
    const workspace = join(f.directory, "workspace"); mkdirSync(workspace);
    const token = "e".repeat(48); let observed = false;
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* Consume application data without logging it. */ }
      observed = request.headers.authorization === `Bearer ${token}`;
      const body = '{"intervalSeconds":1}';
      response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) }); response.end(body);
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address === "object");
    const child = spawn(process.execPath, [script, f.binary], { env: { PATH: process.env.PATH, HOME: f.directory,
      REACH_GATEWAY_URL: `http://127.0.0.1:${address.port}`, REACH_ENGINE_ID: "fixture", REACH_ENGINE_TOKEN: token,
      REACH_WORKSPACE_ROOTS: `default:${workspace}`, REACH_PROCESS_WORKSPACES: "", REACH_SUPERVISOR_TEST_MODE: "1", REACH_SUPERVISOR_TEST_TIMEOUT_MS: "5000" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
    const exit = once(child, "exit");
    try {
      for (let n = 0; n < 1200 && !output.includes("HOST_UPDATE_HEALTHY"); n++) await delay(5);
      assert.ok(output.includes("HOST_UPDATE_HEALTHY"), output); assert.ok(observed); assert.ok(!output.includes(token));
      assert.equal(existsSync(f.pending), false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await exit; }
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(f.directory, { recursive: true, force: true });
    }
  });
});

test("an interrupted pre-activation intent preserves and starts the prior binary", async () => {
  const f = fixture("exit"); copyFileSync(f.previous, f.binary);
  const child = spawn(process.execPath, [script, f.binary], { env: { PATH: process.env.PATH, HOME: f.directory }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
  try {
    assert.equal((await once(child, "exit"))[0], 0); assert.match(stdout, /PRIOR_ENGINE_STARTED/); assert.equal(stderr, ""); assert.equal(existsSync(f.pending), false);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
