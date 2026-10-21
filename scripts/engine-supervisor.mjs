#!/usr/bin/env node
// Private host-update health guard. Normal output remains the Engine's diagnostics.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  constants,
  closeSync,
  copyFileSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const binary = process.argv[2];
if (!binary || !isAbsolute(binary))
  throw new Error("ENGINE_SUPERVISOR_CONFIGURATION_INVALID");
const directory = dirname(binary);
const pendingPath = join(directory, "engine.update-pending.json");
const healthPath = join(directory, "engine.update-health.json");
const previous = join(directory, "engine.prev");
const recoveryPath = join(directory, "engine.update-recovery.json");
const hash = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const remove = (path) => {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
};

function pending() {
  try {
    lstatSync(recoveryPath);
    throw new Error("HOST_UPDATE_RECOVERY_REQUIRED");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let descriptor;
  try {
    descriptor = openSync(
      pendingPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.size > 1024 * 1024 ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.uid !== process.getuid()
    )
      throw new Error();
    const value = JSON.parse(readFileSync(descriptor, "utf8"));
    if (
      value.schemaVersion !== 1 ||
      !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(
        value.version,
      ) ||
      !/^[a-f0-9]{64}$/.test(value.digest) ||
      !/^[a-f0-9]{64}$/.test(value.previousDigest) ||
      hash(previous) !== value.previousDigest
    )
      throw new Error();
    if (
      value.inventory !== null &&
      (!Array.isArray(value.inventory) ||
        value.inventory.length !== 2 ||
        !isAbsolute(value.inventory[0]) ||
        typeof value.inventory[1] !== "string")
    )
      throw new Error();
    const current = hash(binary);
    if (current === value.previousDigest && current !== value.digest) {
      remove(pendingPath);
      return undefined;
    }
    if (current !== value.digest) throw new Error();
    return value;
  } catch (error) {
    if (error.code === "ENOENT" && descriptor === undefined) return undefined;
    throw new Error("HOST_UPDATE_INTENT_INVALID");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

async function run() {
  let intent = pending();
  for (;;) {
    const nonce = randomBytes(16).toString("hex");
    if (intent) remove(healthPath);
    const child = spawn(binary, [], {
      stdio: "inherit",
      env: {
        ...process.env,
        REACH_UPDATE_GUARDED: "1",
        ...(intent
          ? {
              REACH_UPDATE_HEALTH_FILE: healthPath,
              REACH_UPDATE_HEALTH_NONCE: nonce,
            }
          : {}),
      },
    });
    let exited = false;
    const exit = new Promise((resolve) => {
      child.once("error", () => {
        exited = true;
        resolve(1);
      });
      child.once("exit", (code, signal) => {
        exited = true;
        resolve(code ?? (signal ? 1 : 0));
      });
    });
    let stopping = false;
    const stop = (signal) => {
      stopping = true;
      child.kill(signal);
    };
    const term = () => stop("SIGTERM"),
      interrupt = () => stop("SIGINT");
    process.on("SIGTERM", term);
    process.on("SIGINT", interrupt);
    try {
      if (intent) {
        const timeout =
          process.env.REACH_SUPERVISOR_TEST_MODE === "1"
            ? Number(process.env.REACH_SUPERVISOR_TEST_TIMEOUT_MS ?? 1000)
            : 30_000;
        const deadline = Date.now() + timeout;
        let healthy = false;
        while (!exited && !stopping && Date.now() < deadline) {
          try {
            const stat = lstatSync(healthPath);
            if (stat.isFile() && !stat.isSymbolicLink() && stat.size < 1024) {
              const health = JSON.parse(readFileSync(healthPath, "utf8"));
              healthy =
                health.nonce === nonce &&
                health.version === intent.version &&
                health.phase === "heartbeat";
            }
          } catch {
            /* Only the matching fresh heartbeat acknowledges startup. */
          }
          if (healthy) break;
          await delay(25);
        }
        if (stopping) {
          process.exitCode = await exit;
          return;
        }
        if (healthy && !exited) {
          remove(healthPath);
          remove(pendingPath);
          intent = undefined;
          process.stderr.write("HOST_UPDATE_HEALTHY\n");
        } else {
          child.kill("SIGTERM");
          const force = setTimeout(() => child.kill("SIGKILL"), 3000);
          force.unref();
          await exit;
          clearTimeout(force);
          writeFileSync(
            recoveryPath,
            JSON.stringify({ version: intent.version, state: "restoring" }),
            { mode: 0o600, flag: "wx" },
          );
          const temporary = binary + ".restore";
          copyFileSync(previous, temporary);
          renameSync(temporary, binary);
          if (intent.inventory) {
            const [path, data] = intent.inventory;
            writeFileSync(path + ".restore", data, { mode: 0o600 });
            renameSync(path + ".restore", path);
          }
          remove(healthPath);
          remove(pendingPath);
          remove(recoveryPath);
          intent = undefined;
          process.stderr.write(
            "HOST_UPDATE_ROLLED_BACK: prior Engine restored after failed startup health\n",
          );
          process.off("SIGTERM", term);
          process.off("SIGINT", interrupt);
          continue;
        }
      }
      process.exitCode = await exit;
      process.off("SIGTERM", term);
      process.off("SIGINT", interrupt);
      return;
    } finally {
      if (!exited) {
        child.kill("SIGTERM");
        const force = setTimeout(() => child.kill("SIGKILL"), 3000);
        force.unref();
        await exit;
        clearTimeout(force);
      }
      process.off("SIGTERM", term);
      process.off("SIGINT", interrupt);
    }
  }
}

try {
  await run();
} catch {
  process.stderr.write(
    "HOST_UPDATE_RECOVERY_REQUIRED: retain private Engine backup and health intent\n",
  );
  process.exitCode = 1;
}
