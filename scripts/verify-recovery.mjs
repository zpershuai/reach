import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { HttpGatewayClient } from "../packages/grok-bot-mcp-connector/dist/gateway.js";

const execute = promisify(execFile);
const config = JSON.parse(await readFile(process.argv[2] ?? ".reach/deployment.json", "utf8"));
const verification = JSON.parse(await readFile(process.argv[3] ?? ".reach/remote-verification.json", "utf8"));
const recovery = config.recovery;
if (process.platform !== "darwin") throw new Error("Recovery verification requires a local macOS Engine managed by launchd");
if (!recovery?.gatewaySshTarget || !recovery.gatewayComposeDir) {
  throw new Error("Set recovery.gatewaySshTarget and recovery.gatewayComposeDir in the private deployment config");
}
if (!/^[A-Za-z0-9][A-Za-z0-9@._-]*$/.test(recovery.gatewaySshTarget) || !recovery.gatewayComposeDir.startsWith("/")) {
  throw new Error("Recovery requires a valid SSH target and absolute Compose directory");
}
const sshArgs = ["-o", "BatchMode=yes"];
if (recovery.gatewaySshPort !== undefined) {
  if (!Number.isInteger(recovery.gatewaySshPort) || recovery.gatewaySshPort < 1 || recovery.gatewaySshPort > 65535) throw new Error("Invalid recovery gatewaySshPort");
  sshArgs.push("-p", String(recovery.gatewaySshPort));
}
const quoteShell = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
sshArgs.push(recovery.gatewaySshTarget, `cd ${quoteShell(recovery.gatewayComposeDir)} && docker compose restart gateway`);
const client = new HttpGatewayClient({ id: config.engineId, engineId: config.engineId, gatewayUrl: config.gatewayUrl, controllerToken: config.controllerToken }, 150000, 250);
const target = `gui/${process.getuid()}/${recovery.launchdLabel ?? process.env.REACH_LAUNCHD_LABEL ?? "org.reach.engine"}`;
const pid = async () => {
  const { stdout } = await execute("launchctl", ["print", target]);
  return Number(stdout.match(/\bpid = (\d+)/)?.[1] ?? 0);
};
async function waitFor(action) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try { if (await action()) return; } catch { /* retry observation, never RPC */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Service recovery observation timed out");
}
async function proveRead() {
  const response = await client.rpc("fs.read", { workspace: "default", path: verification.probe });
  assert.equal(response.type, "response", JSON.stringify(response));
  assert.ok(response.result.content.includes("deployment and edit verified"));
}
const results = [];
let enginePidBefore;
let enginePidAfter;
try {
  await client.openAndWait();
  await proveRead();
  await execute("ssh", sshArgs, { timeout: 60000 });
  await waitFor(async () => {
    const response = await fetch(`${config.gatewayUrl}/healthz`, { signal: AbortSignal.timeout(5000) });
    const body = await response.json();
    return response.ok && body.protocol === "reach-rpc/1.0";
  });
  await client.openAndWait();
  await proveRead();
  results.push("Gateway restart during a live session; fresh WSS session and file read succeed");
  console.log("PASS Gateway restart recovers a new session and reads the persisted file");
  enginePidBefore = await pid();
  assert.ok(enginePidBefore > 0);
  await execute("launchctl", ["kill", "SIGKILL", target]);
  await waitFor(async () => {
    const current = await pid();
    return current > 0 && current !== enginePidBefore;
  });
  enginePidAfter = await pid();
  await waitFor(async () => (await client.status()).status === "none");
  await client.openAndWait();
  await proveRead();
  results.push("Engine crash during a live session; launchd restarts it; fresh session and read succeed");
  console.log("PASS launchd restarts the crashed Engine and remote file access recovers");
} finally {
  await client.close();
}
await writeFile(".reach/recovery-verification.json", JSON.stringify({ checkedAt: new Date().toISOString(), enginePidBefore, enginePidAfter, results }, null, 2));
