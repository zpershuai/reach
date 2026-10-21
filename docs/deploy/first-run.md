# First run: one machine, scoped client, script, revoke and uninstall

This walkthrough runs a Gateway and one Engine from source on a single Linux or macOS machine, connects a scoped MCP client, enables one trusted Node script, revokes the client and the device, and uninstalls. Everything listens on `127.0.0.1`. It uses reserved names (`engine-a`, `docs`, `scripts`) and credentials generated locally. For a remote Gateway with HTTPS, follow the [deployment guide](README.md) afterwards.

Run every step as an ordinary non-root account. Reach does not need root, and a script you enable later runs with the Engine account's privileges, so use an account (or VM/container) whose access you are prepared to give to that script.

## 0. Prerequisites

| Tool | Notes |
| --- | --- |
| Git, curl, Python 3 | Python generates the private config below |
| Node.js 24 with npm | CI verifies with the exact version in `scripts/toolchain.json` |
| Rust toolchain with cargo | CI verifies with the exact version in `scripts/toolchain.json`; other versions are untested |
| A browser and a TOTP authenticator app | Required for the one-time administrator setup in the console |

## 1. Build

```bash
git clone https://github.com/example/reach.git && cd reach
npm --prefix packages/reach-rpc ci --ignore-scripts
npm --prefix packages/reach-rpc run build
npm --prefix packages/gateway-console ci --ignore-scripts
npm --prefix packages/gateway-console run build
cargo build --release --locked -p reach-rpc --bin engine
```

Replace the clone URL with the repository you obtained Reach from. The console build is copied into the Gateway output; without it, `/console/` is not served.

## 2. Create a private demo directory

The following creates `~/reach-demo` with private env files, an empty Gateway data directory and two workspaces. It refuses to overwrite an existing directory and prints no credential.

```bash
python3 - <<'PY'
import json, os, secrets, shutil
from pathlib import Path
demo = Path.home() / 'reach-demo'
demo.mkdir(mode=0o700)
for name in ['gateway-data', 'workspaces/docs', 'workspaces/scripts']:
    (demo / name).mkdir(mode=0o700, parents=True)
(demo / 'workspaces/docs/readme.txt').write_text('Hello from the docs workspace.\n')
engine_token = secrets.token_hex(32)
files = {
    'gateway.env': {
        'REACH_CONTROLLER_TOKEN': secrets.token_hex(32),
        'REACH_ENGINE_ID': 'engine-a',
        'REACH_ENGINE_TOKEN': engine_token,
        'REACH_DATA_DIR': str(demo / 'gateway-data'),
        'REACH_HEARTBEAT_INTERVAL_SECS': '5',
    },
    'engine.env': {
        'REACH_GATEWAY_URL': 'http://127.0.0.1:8787',
        'REACH_ENGINE_ID': 'engine-a',
        'REACH_ENGINE_TOKEN': engine_token,
        'REACH_WORKSPACES_FILE': str(demo / 'workspaces.json'),
        'REACH_PROCESS_NODE_BIN': shutil.which('node'),
    },
}
for name, values in files.items():
    with os.fdopen(os.open(demo / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as output:
        output.writelines(f'{key}={value}\n' for key, value in values.items())
workspaces = {'workspaces': {'docs': {'path': str(demo / 'workspaces/docs')},
                             'scripts': {'path': str(demo / 'workspaces/scripts')}}}
(demo / 'workspaces.json').write_text(json.dumps(workspaces, indent=2) + '\n')
print('Created', demo)
PY
```

`REACH_CONTROLLER_TOKEN` is the Owner credential: it can reach every Engine and workspace. Keep it for administration only. The 5-second heartbeat makes this local demo responsive; the default is 120 seconds. `REACH_PROCESS_NODE_BIN` points the Engine at your Node for scripts; installed Engines use the private runtime under `~/.reach/runtime/node` instead.

## 3. Start the Gateway (terminal 1)

```bash
cd reach
set -a; . ~/reach-demo/gateway.env; set +a
node packages/reach-rpc/dist/gateway-main.js
```

It prints `Reach gateway v… listening on http://127.0.0.1:8787` and a reminder to read the setup credential privately. It does not print the credential.

## 4. Create the administrator

1. Print the one-time setup credential in your own terminal: `cat ~/reach-demo/gateway-data/admin-setup-token`. Do not paste it into logs, issues or chats.
2. Open `http://127.0.0.1:8787/console/`, enter the setup credential, scan the TOTP secret into your authenticator, then choose a password of at least 12 characters and confirm a TOTP code.
3. Save the recovery codes privately. The setup file is deleted after a successful setup.

## 5. Pair the Engine (terminal 2)

The Gateway and Engine env files share the Engine ID and Engine token; that pair is the device enrollment. Start the Engine:

```bash
cd reach
set -a; . ~/reach-demo/engine.env; set +a
./target/release/engine
```

The console's **Devices** page shows `engine-a` online within a few seconds. Engines added later from **Devices → Add device** receive their own token from the console instead.

## 6. Create a scoped client

In the console, open **Clients → Client identities & permissions → Create delegated client**. Name it `demo-client`, choose a short expiry, and add two resources:

| Engine | Workspace | read | write | execute |
| --- | --- | --- | --- | --- |
| `engine-a` | `docs` | ✓ | | |
| `engine-a` | `scripts` | ✓ | ✓ | ✓ |

Create the client and copy the token, which is shown once, into a private file without echoing it:

```bash
umask 077; cat > ~/reach-demo/client-token   # paste the token, press Enter, then Ctrl-D
```

The same policy can be created through the [console API](client-access.md#api-字段) (`POST /api/console/access-clients`).

## 7. Use the client over MCP

An MCP host connects with:

```json
{
  "mcpServers": {
    "reach": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer <demo-client-token>" }
    }
  }
}
```

To see the same calls without a host, use curl in a third terminal:

```bash
mcp() {
  curl -sS -D ~/reach-demo/mcp-headers http://127.0.0.1:8787/mcp \
    -H "authorization: Bearer $(cat ~/reach-demo/client-token)" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    ${MCP_SESSION:+-H "mcp-session-id: $MCP_SESSION" -H "mcp-protocol-version: 2025-06-18"} \
    --data "$1"; echo
}
tool() { mcp "{\"jsonrpc\":\"2.0\",\"id\":$RANDOM,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}"; }

unset MCP_SESSION
mcp '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
MCP_SESSION=$(awk 'tolower($1)=="mcp-session-id:" {print $2}' ~/reach-demo/mcp-headers | tr -d '\r')
mcp '{"jsonrpc":"2.0","method":"notifications/initialized"}'

tool list_devices '{}'
tool list_workspaces '{"deviceId":"engine-a"}'   # repeat until it reports "ready"
```

`list_workspaces` first returns `connecting` while the Engine opens its session. Once ready it lists `docs` and `scripts`, and `processWorkspaces` is empty because no workspace allows execution yet. Then:

```bash
tool fs_read  '{"deviceId":"engine-a","workspace":"docs","path":"readme.txt"}'
tool fs_write '{"deviceId":"engine-a","workspace":"docs","path":"new.txt","content":"x","mode":"create"}'
tool fs_write '{"deviceId":"engine-a","workspace":"scripts","path":"hello.mjs","content":"console.log(`hello from ${process.version}`)\n","mode":"create"}'
tool list_workspaces '{"deviceId":"engine-b"}'
```

The read succeeds. The write to `docs` returns a tool error with `PERMISSION_DENIED`, because the client has only read access there, and nothing is written. The write to `scripts` succeeds. `engine-b` is not in the policy. The Gateway answers exactly as it would for a device that does not exist: for a scoped client, an HTTP 404 with a JSON-RPC error that reveals nothing about the device.

## 8. Enable one trusted script

Execution is off until the Engine's own configuration allows it; the client's `execute` permission alone is not enough:

```bash
tool process_run '{"deviceId":"engine-a","workspace":"scripts","script":"hello.mjs","launchId":"hello-1"}'
```

This returns `PROCESS_EXECUTION_DISABLED` and starts nothing. Review the script, then allow execution in that one workspace by editing `~/reach-demo/workspaces.json`:

```json
{
  "workspaces": {
    "docs": { "path": "/home/example/reach-demo/workspaces/docs" },
    "scripts": { "path": "/home/example/reach-demo/workspaces/scripts", "process": true }
  }
}
```

Keep your real absolute paths from the generated file and only add `"process": true`. The Engine reloads the file within about 2 seconds. Run the script with a new launch ID and read its output:

```bash
tool list_workspaces '{"deviceId":"engine-a"}'      # processWorkspaces now lists "scripts"
tool process_run '{"deviceId":"engine-a","workspace":"scripts","script":"hello.mjs","launchId":"hello-2"}'
tool process_status '{"deviceId":"engine-a","launchId":"hello-2"}'
tool process_logs '{"deviceId":"engine-a","processId":"<processId from process_run>"}'
```

The script has the Engine account's OS permissions. The workspace limits which entry file can be started; it is not a sandbox. Anyone who can write `scripts` can change what runs there, so grant write and execute together only to clients you trust equally.

## 9. Revoke the client and the device

Revoke the client in the console: **Revoke identity** on `demo-client`. Its next request fails:

```bash
tool list_devices '{}'   # HTTP 401; the client's Engine session and processes are cleaned up
```

To revoke the device credential, stop the Engine (Ctrl-C in terminal 2), stop the Gateway (Ctrl-C in terminal 1), give the Gateway a new Engine token, and restart it:

```bash
python3 - <<'PY'
import secrets
from pathlib import Path
path = Path.home() / 'reach-demo/gateway.env'
lines = [line for line in path.read_text().splitlines() if not line.startswith('REACH_ENGINE_TOKEN=')]
path.write_text('\n'.join(lines + ['REACH_ENGINE_TOKEN=' + secrets.token_hex(32)]) + '\n')
PY
set -a; . ~/reach-demo/gateway.env; set +a
node packages/reach-rpc/dist/gateway-main.js
```

An Engine started with the old `engine.env` is now refused: it logs `HEARTBEAT_FAILED` and never comes online. Devices added from the console are revoked with **Devices → Remove** instead, which takes effect without a restart.

## 10. Uninstall

Stop the Gateway and the Engine (Ctrl-C), then remove only the demo's configuration, credentials and Gateway data. Keep the workspaces unless you explicitly decide to delete them:

```bash
cd ~/reach-demo
rm -r gateway-data
rm gateway.env engine.env client-token mcp-headers workspaces.json
ls workspaces/docs workspaces/scripts   # your files are still here
```

Remove the source checkout and its build outputs (`target/`, `node_modules/`, `dist/`) when you no longer need them. For Engines installed as a LaunchAgent, systemd or procd service, follow [operations](operations.md#停用组件); the installers likewise keep workspaces and private configuration until you remove them deliberately.
