import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { hashPassword, normalizeUsername, validPassword } from "./credentials.js";
import { ConsoleStore } from "./store.js";
import { UserStore } from "./users.js";

export interface AdminCliIo {
  stdin: Readable & { isTTY?: boolean };
  stdout: Writable;
  stderr: Writable;
  env: NodeJS.ProcessEnv;
}

const usage = "Usage: node dist/gateway-main.js admin reset-password <username>\n"
  + "Reads the new password from an interactive prompt, or from the first line of standard input.\n"
  + "Requires REACH_DATA_DIR. Clears the account's authenticator, enables it and signs it out everywhere.\n";

/** Prompts without echoing what is typed. */
function promptHidden(io: AdminCliIo, question: string): Promise<string> {
  return new Promise(resolve => {
    const rl = createInterface({ input: io.stdin, output: io.stdout, terminal: true });
    const output = rl as unknown as { _writeToOutput: (text: string) => void };
    let asked = false;
    output._writeToOutput = text => { if (!asked) { io.stdout.write(text); asked = true; } };
    rl.question(question, answer => { rl.close(); io.stdout.write("\n"); resolve(answer); });
  });
}

async function firstLine(stdin: Readable): Promise<string> {
  let data = "";
  for await (const chunk of stdin) {
    data += chunk.toString();
    if (data.includes("\n") || data.length > 4096) break;
  }
  return data.split(/\r?\n/)[0];
}

/** Runs `admin <command>` against REACH_DATA_DIR and returns the process exit code. Never prints secrets. */
export async function runAdminCommand(args: string[], io: AdminCliIo): Promise<number> {
  const [command, rawUsername, ...extra] = args;
  if (command !== "reset-password" || !rawUsername || extra.length) { io.stderr.write(usage); return command === "--help" || command === "-h" ? 0 : 2; }
  const dataDir = io.env.REACH_DATA_DIR?.trim();
  if (!dataDir) { io.stderr.write("ADMIN_RESET_FAILED: set REACH_DATA_DIR to the Gateway data directory\n"); return 1; }
  const username = normalizeUsername(rawUsername);
  const store = new ConsoleStore(dataDir);
  try {
    const users = new UserStore(store);
    const account = username ? users.credentialsFor(username) : undefined;
    if (!account) { io.stderr.write(`ADMIN_RESET_FAILED: no console account named "${username ?? "(invalid)"}"\n`); return 1; }
    let password: string;
    if (io.stdin.isTTY) {
      password = await promptHidden(io, `New password for ${account.username}: `);
      if (await promptHidden(io, "Repeat the new password: ") !== password) { io.stderr.write("ADMIN_RESET_FAILED: passwords do not match\n"); return 1; }
    } else password = await firstLine(io.stdin);
    if (!validPassword(password)) { io.stderr.write("ADMIN_RESET_FAILED: password must contain 12 to 1024 characters\n"); return 1; }
    users.setPassword(account.id, await hashPassword(password), {
      reset: true,
      // The reset and its audit record commit together; activity keeps admin actions in `method`.
      alsoRecord: user => store.db.prepare("INSERT INTO activity (ts,event_type,client_label,client_type,method,outcome) VALUES (?,?,?,?,?,?)")
        .run(Date.now(), "admin.action", "Host CLI", "console", `user.password.reset:${user.username}`, "ok"),
    });
    io.stdout.write(`Password reset for ${account.username}; authenticator cleared, account enabled and existing sessions signed out.\n`);
    return 0;
  } finally { store.close(); }
}
