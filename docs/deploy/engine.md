# Deploy Engine on Mac

English | [简体中文](engine_cn.md)

Engine is a Rust executable that accesses device workspaces. HTTPS heartbeats wait for session requests; WSS connects on demand. It opens no inbound Mac listener. This guide uses macOS LaunchAgent; see [Linux systemd](linux.md) and [x86_64 OpenWrt procd](openwrt.md) for those platforms.

## Install from a Release without building locally

After preparing `engine.env` below, install a prebuilt GitHub Release from the checkout and skip section 2:

```bash
bash scripts/install-engine.sh .reach/engine.env
```

The script uses `uname` to select `engine-darwin-arm64`, `engine-darwin-x64` or `engine-linux-x64-musl`, downloads the latest `engine-v*` Release, verifies Release `SHA256SUMS` and `engine --version`, then calls the LaunchAgent or [Linux installer](linux.md). Failed verification prevents installation. Pin with `REACH_ENGINE_VERSION=0.3.2`; the default repository is `zpershuai/reach`. Override a fork/retained old distribution with `REACH_RELEASE_REPO=owner/repo`; `REACH_INSTALL_DRY_RUN=1` only downloads/verifies. On macOS, the second argument (MCP devices JSON) passes unchanged to the LaunchAgent installer; build MCP Connector first if using it.

## 1. Configuration and workspaces

Prepare `.reach/engine.env` using [Configuration](configuration.md). It contains:

```dotenv
REACH_GATEWAY_URL=https://reach.example.com
REACH_ENGINE_TOKEN=<independently-generated-64-character-engine-credential>
REACH_ENGINE_ID=engine-a
REACH_WORKSPACE_ROOTS=default:/Users/example/.reach/workspace
```

The token is a placeholder; use private configuration. Engine ID must match Gateway. Use the actual absolute path for the target account/device and create the chosen workspace on that Mac:

```bash
mkdir -p "$HOME/.reach/workspace"
chmod 700 "$HOME/.reach/workspace"
```

File RPC `workspace` is a configured name such as `default`; `path` is relative, e.g. `notes/today.txt`. Do not expose the entire home or system root as a default workspace. Unix uses directory descriptors and no-follow traversal to reject escapes and symlink bypasses; still choose only files explicitly permitted for remote access.

In environment mode, add roots with `default:/absolute/path,notes:/another/path`, prepare directories and restart Engine. Clients cannot expand roots by passing arbitrary absolute paths.

MCP clients discover workspace names/execution flags with `list_workspaces({deviceId})`. This reads Engine `session.ready` metadata without exposing absolute roots. Use returned names; do not assume `default` exists.

### Dynamic workspace file, Engine 0.3.0 onward

For additions/removals/root changes without restart, use local JSON. Create all roots, remove `REACH_WORKSPACE_ROOTS` and `REACH_PROCESS_WORKSPACES` from service env, set `REACH_WORKSPACES_FILE=/home/example/.reach/workspaces.json` and restart once. On macOS, `/Users/example/.reach/workspaces.json` is suitable; use a path readable by the actual service user.

```json
{
  "workspaces": {
    "default": { "path": "/home/example/.reach/workspace" },
    "scripts": { "path": "/home/example/reach-scripts", "process": true }
  }
}
```

`process` defaults to `false`. Only these keys are allowed. Declare at least one nonempty name and existing absolute directory; file mode creates no roots. Roots resolve to real directories, so a symlink to the same directory is not a root change. JSON expands neither `~` nor `$HOME` and must contain no tokens or Gateway settings.

An explicit file wins, then either workspace environment variable. With none, existing `~/.reach/workspaces.json` is discovered; otherwise built-in `default` remains. Explicit file plus either environment variable fails startup. Environment mode does not hot reload or detect a default file created later.

File mode checks every two seconds, during idle heartbeats and between session requests. Unix `kill -HUP <engine-pid>` requests reload on the next loop. Prefer atomic temporary-file rename. Invalid JSON, unknown keys, empty workspace sets, bad roots, deletion or unreadable files reject the whole change, retaining last valid configuration and logging `WORKSPACE_RELOAD_FAILED` without contents. Rejected files retry each poll, logging the same reason once: creating a previously missing root applies without rewriting JSON. Such errors at startup exit immediately.

Changes wait for current requests to finish. Removing/changing a root invalidates its cursors with `INVALID_CURSOR` and stops current-session processes there. Disabling `process` also stops processes and rejects new launches. Other workspaces' cursors/processes continue. Access to removed names returns `WORKSPACE_ACCESS_DENIED`.

Engine sends updated `session.ready` in the same session; `list_workspaces` and console see new names. Upgrade Gateway to 0.7.2 first. It revokes file/execute grants for removed/replaced roots and execute grants when execution is disabled; processId-bound control grants remain until expiry. Old Gateways refresh names but cannot revoke grants on root replacement, leaving up to five minutes of validity. Use a new workspace name with old Gateway instead of replacing a root in place. See [Versions](versions.md) for migration/rollback.

## 2. Build a binary for the target platform

From the target Mac's repository root:

```bash
cargo build --release --locked --bin engine
```

Output is `target/release/engine`. Rust, initial dependency downloads and native macOS build tools are required. Build Intel/Apple Silicon in the matching target environment.

To install MCP too, first build it:

```bash
npm --prefix packages/reach-rpc ci --ignore-scripts
npm --prefix packages/grok-bot-mcp-connector run build
```

## 3. Install the background service

Run as the currently logged-in GUI user without `sudo`:

```bash
bash scripts/install-engine-macos.sh .reach/engine.env
```

Alternatively install MCP runtime files, devices JSON and client configuration together:

```bash
bash scripts/install-engine-macos.sh .reach/engine.env .reach/devices.json
```

Choose one command. The second needs built `dist`. Every Engine installation prepares an independent Node.js runtime without requiring Node in system PATH. The installer puts the absolute `~/.reach/runtime/node/bin/node` path in MCP client configuration.

[node-runtime.json](../../scripts/node-runtime.json) pins Node version and platform SHA-256; archives come from `https://nodejs.org/dist/`. First install downloads them; later runs verify/reuse a complete matching runtime and replace missing/corrupt installations. Download, digest or execution-check failure aborts while preserving the previous runtime/service. Runtime activation atomically swaps a symlink, retaining old release directories for running processes.

The [installer](../../scripts/install-engine-macos.sh) copies outputs/configuration, writes wrapper/plist, unloads a matching service and registers it again. Reinstallation restarts Engine and interrupts its session; it does not compile sources.

Use a staged config file in the repository, not installed `~/.config/reach/engine.env` copied onto itself. For upgrades stage a copy of installed configuration; see [Operations](operations.md).

## 4. Installed files

| File | Purpose |
| --- | --- |
| `~/.local/share/reach/engine` | Executable, 755 |
| `~/.local/share/reach/start-engine.sh` | Loads private env and executes Engine, 700 |
| `~/.reach/runtime/node/bin/node` | Stable independent Node entry, installed automatically |
| `~/.reach/runtime/node/bin/npm`, `npx` | Included package-manager entry points |
| `~/.reach/versions.json` | Installed Engine/MCP/Node versions |
| `~/.local/share/reach/run-node.sh` | JS launcher using the independent runtime, 755 |
| `~/.config/reach/engine.env` | Private configuration, 600 |
| `~/Library/LaunchAgents/org.reach.engine.plist` | User background task |
| `~/.local/share/reach/engine.log` | Stdout/lifecycle events |
| `~/.local/share/reach/engine-error.log` | Stderr/startup failures |
| `~/.config/reach/mcp-devices.json` | Only with MCP installation, 600 |
| `~/.config/reach/mcp.json` | MCP client launch configuration, only with MCP installation |

Runtime/configuration directories are 700. See [MCP](mcp.md) for installation details.

Rust Engine runs independently. `REACH_PROCESS_WORKSPACES` explicitly enables trusted scripts; `REACH_PROCESS_NODE_BIN` selects their private interpreter. See [Script tasks](processes.md). Gateway/MCP on the same host can use installed `run-node.sh`; `REACH_NODE_BIN` only overrides that launcher's executable path. See [Node runtime](node-runtime.md).

```bash
"$HOME/.local/share/reach/run-node.sh" /absolute/path/to/gateway-main.js
"$HOME/.local/share/reach/run-node.sh" /absolute/path/to/mcp/dist/main.js
```

Source builds still require Rust and Node/npm tools. Installers also need Python 3 and archive extraction tools; runtime installation itself does not depend on system Node.

New installations default to LaunchAgent label `org.reach.engine`, overridable with `REACH_LAUNCHD_LABEL`. Upgrades retain an existing label pointing to the same start script; use the actual label below. `RunAtLoad=true`, `KeepAlive=true`, `ThrottleInterval=10` restart crashed processes. Persistent configuration errors may cause repeated restarts: inspect stderr and fix configuration.

## 5. Inspect and manage

```bash
launchctl print "gui/$(id -u)/org.reach.engine"
tail -n 40 "$HOME/.local/share/reach/engine.log"
tail -n 40 "$HOME/.local/share/reach/engine-error.log"
```

Immediately after registration, wrapper/`xpcproxy` may appear briefly. Recheck PID/logs shortly. Idle heartbeats do not imply `session.ready`: WSS starts only after a Controller opens a session.

Restart a registered service:

```bash
launchctl kickstart -k "gui/$(id -u)/org.reach.engine"
```

Stop/unload for this login:

```bash
launchctl bootout "gui/$(id -u)/org.reach.engine"
```

Register again:

```bash
launchctl bootstrap "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/org.reach.engine.plist"
```

`bootout` retains the plist, which may load at next login; see [Operations](operations.md) for permanent shutdown. Killing a KeepAlive process restarts it and is not a stop method.

## 6. Connection and runtime limits

- Public Gateway URLs must be valid-certificate HTTPS roots. Plain HTTP is loopback-only. Do not provide both URL env and command-line URL.
- Engine verifies session endpoints remain on the same origin, rejecting others. Network failures back off heartbeats; clients must reopen sessions.
- Sleeping, disconnected or logged-out Macs are unavailable. LaunchAgent is not a system daemon that runs without login.
- Engine provides file tools, not arbitrary shell execution. OS permissions of the service account still constrain RPC.
- Engine logs append without installer-provided rotation. Manage them separately; container rotation does not rotate Mac logs.
- Linux uses [systemd](linux.md), OpenWrt [procd](openwrt.md).

See [Configuration](configuration.md) for all parameters and [Verification](verification.md) for real file tests.

## 7. Hardware types and console display

Engine detects hardware once at startup and reports five `device.hardware` fields with each heartbeat: `kind`, `model`, `os`, `osVersion`, `arch`. Each permits at most 64 printable characters. Detection uses local macOS information, OpenWrt board model, Raspberry Pi device tree, Synology/QNAP system files or Linux DMI; subprocesses share a three-second budget. Failed detection still heartbeats with kind `unknown`.

Reports exclude serial numbers, hostnames, MAC addresses, usernames and other network identifiers. Gateway ignores malformed/oversized reports, retaining the last valid value. Older Engines without hardware still connect and get a generic server glyph.

Console administrators may set/clear type/model overrides. They take display precedence without changing permissions or local Engine configuration.

## macOS installer recovery verification scope

The installer validates/stages in a private temporary directory, stops the old service, atomically replaces each file and starts. Failures restore files, runtime pointer and supervisor state. First-install failures remove new targets while preserving workspaces; recovery failures retain private backups for manual action and do not count as successful upgrades. Isolated macOS supervisor fixtures cover staging, activation, start/health, preservation of old configuration and initial-failure cleanup. They do not certify real LaunchAgent/procd devices. See [Operations](operations.md) for platform acceptance/recovery.
