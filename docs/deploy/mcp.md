# Reach MCP installation and client configuration

English | [简体中文](mcp_cn.md)

Reach offers a local stdio Connector launched by desktop clients and remote HTTPS `/mcp` on Gateway for clients such as Grok Bot. Engine executes file tools in both cases. HTTP shares Gateway's port/domain/container without another service.

Stdio Gateway URLs also require HTTPS; local HTTP is limited to `localhost`, IPv4 127/8 and IPv6 `::1`. URLs reject embedded credentials, queries and fragments; requests never follow redirects. Static stdio `session.close` closes only its owned session for the specified device. Without ownership it returns `closed=false`, `owned=false`, without switching or opening a session.

`packages/grok-bot-mcp-connector` and the npm name retain historical naming; the actual MCP server is `reach-mcp`. Use the following with clients supporting the chosen transport.

## Grok Bot, remote HTTP

Build/update Gateway, then run `node scripts/configure-grok-plugin.mjs .reach/deployment.json` from repository root and install generated private `.reach/grok-bot-plugin/`; see [plugin documentation](../../grok-bot-plugin/README.md). `gatewayUrl` must be a public HTTPS root; the generator appends `/mcp`. The host only needs a private **client token** prompt, preferably scoped delegated. Do not use Engine token, `REACH_MCP_DEVICES` or a local Node process. Generic configuration:

```json
{
  "mcpServers": {
    "reach": {
      "type": "http",
      "url": "https://reach.example.com/mcp",
      "headers": { "Authorization": "Bearer <delegated-client-token>" }
    }
  }
}
```

Store credentials in private client settings. Create a scoped token using [Client permissions](client-access.md); Owner access covers all resources and should not be used daily. The plugin uses a complete literal URL, with a token variable only in Authorization, without relying on URL interpolation. The repository template uses a reserved example address; install a private generated copy. Generation copies no token and refuses to overwrite an existing copy; edit its private URL when changing addresses. Never commit real URLs/tokens.

HTTP exposes a fixed set: `list_devices`, `get_versions`, `pick_device`, `list_workspaces`, `device_status`, `fs_read`, `fs_write`, `fs_edit`, `fs_list`, `fs_glob`, `fs_stat`, `fs_grep`, `process_run`, `process_status`, `process_logs`, `process_stop`, `process_list`, `session_close`. Workspace/file/process/session_close tools require `deviceId`, equal to registered `engineId`. Devices include default/additional Gateway registration, never client device files. `lastSeenAt` is last heartbeat; historical version data does not imply online status.

Call `list_devices`, then `list_workspaces({"deviceId":"engine-a"})`. Initial discovery, `pick_device` or file calls create connection intent immediately. Until ready they return `{"status":"connecting","retryAfterMs":1000}` without executing file operations. Poll `device_status` at that interval until `ready` and `owned: true`, then call `list_workspaces` again. Status neither reopens nor cancels intent. Default idle heartbeat is 120 seconds; `REACH_HEARTBEAT_INTERVAL_SECS=15` lowers latency at a traffic/power cost.

Example ready result: `{"deviceId":"engine-a","status":"ready","workspaces":["notes","scripts"],"processWorkspaces":["scripts"]}`. Use returned file names and only executable names for scripts. These reflect Engine configuration without absolute host paths; never assume `default`. Old Engines lacking execution metadata return `[]`; absent workspace metadata returns `WORKSPACES_UNAVAILABLE`, requiring upgrades.

One HTTP MCP session may own multiple Engines. Contention returns `ENGINE_BUSY`, never automatic takeover. Call `session_close` per device when finished. Controller-token `DELETE /mcp` and idle expiry close that MCP session's Engines. OAuth sessions share ownership by approved application, allowing later MCP sessions to continue. After the last session idles out, one additional idle TTL (default five minutes) allows reconnection before Engine close. Explicit last-session DELETE, console disconnect or Gateway shutdown has no grace. Cleanup targets bound identity only, retaining failed records/retrying.

`session_close` cannot close another caller's Engine. A busy device not owned by this MCP session returns `ENGINE_BUSY`. Retirement schedules cleanup immediately; POSTs still reading bodies and queued requests return 404 without starting tools. Already-running operations finish before cleanup; timeout does not imply write cancellation.

Initialization returns `Mcp-Session-Id`, required later; missing yields 400, unknown/expired 404 and requires reinitialization. MCP `2025-03-26` and `2025-06-18` are supported; subsequent `MCP-Protocol-Version` must match negotiation. Notifications return empty 202; POST requests return JSON.

Gateway declares `capabilities.tools.listChanged: true`. GET the same `/mcp` with authentication/session/protocol headers and `Accept: text/event-stream` for `notifications/tools/list_changed`. Each session retains one stream; a new GET replaces the old one. Stream disconnect does not close Engines. Initial/reconnected streams receive one invalidation after `notifications/initialized`; reload `tools/list`. HTTP tools are fixed, so heartbeats, device selection and tool calls do not repeatedly notify. Server catalog changes can explicitly notify clients.

Streams heartbeat every 15 seconds and disconnect readers buffering over 1 MiB; keepalives do not extend idle TTL. DELETE, idle retirement, console disconnect and Gateway shutdown end streams. Expired/revoked OAuth closes by the next keepalive check; valid tokens can reconnect. This stream carries server notifications only, not console SSE, POST results or replay. Hosts such as ChatGPT may cache conversation tools; refresh connection metadata and verify `list_workspaces` in a new conversation.

Default response budget is 25 seconds including queue/execution, idle TTL five minutes. The **whole HTTP JSON body** is limited to 64 KiB including escapes/metadata; existing Caddy `max_size 64KB` is sufficient. WebSocket remains 1 MiB. Read revision before writing; pass `ifMatch` for overwrite/edit or `mode: create` for new files. After timeout reread before retrying: a write may have committed.

The received body defines 64 KiB; internal session/policy/deadline additions do not reduce it. Reading, queued and executing requests all count against the session request limit. Body reads suppress idle expiry but remain within response budget.

All methods verify Owner, delegated or OAuth credentials; unauthenticated use is loopback-only. Requests carrying Origin are rejected by default; clients without it work. Inspect the actual host's Origin without recording Authorization. If present, configure observed/approved complete values in comma-separated `REACH_MCP_ALLOWED_ORIGINS`; otherwise leave empty. Never use wildcard/disable checks. See [Configuration](configuration.md) and [Verification](verification.md). Methods A–C below are stdio only.

## ChatGPT and other OAuth clients, remote HTTP

ChatGPT custom connectors (Developer mode / Apps) accept no static Authorization header: use OAuth or unauthenticated mode. Enable console with `REACH_DATA_DIR` and HTTPS `REACH_PUBLIC_ORIGIN`, then finish admin setup. Gateway becomes the MCP authorization server while Controller tokens remain usable:

- Unauthenticated `/mcp` returns 401 with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"`.
- Metadata: `/.well-known/oauth-protected-resource` (RFC 9728), `/.well-known/oauth-authorization-server` (RFC 8414).
- Dynamic `POST /oauth/register` (RFC 7591); redirects require HTTPS or loopback HTTP.
- Authorization code with PKCE `S256` only. `GET /oauth/authorize` renders approval; `POST /oauth/token` issues one-hour access/rotating 30-day refresh tokens; `POST /oauth/revoke` implements RFC 7009.

This is a browser authorization-code flow, not RFC 8628 device-code flow.

1. Create a ChatGPT connector with `https://reach.example.com/mcp`, **OAuth**, and blank client ID/secret for dynamic registration.
2. On Gateway approval, verify application/callback domain, explicitly select Engine/workspace/read/write/execute (all off by default), then submit administrator password/fresh TOTP or recovery code and **Approve**. No selection grants no authority. **Deny** returns `access_denied`. TOTP works once; after console login wait for the next code.
3. ChatGPT refreshes automatically. **Clients → Authorized apps → Revoke** immediately deletes that app's tokens and requires recent password confirmation.

Approval shares login failure limits/audit. Actions are `oauth.authorize:<name>` and `oauth.revoke:<id>`. Tokens are SHA-256 digests in `reach.db`. Anonymous registration allows 20/client address/hour; unapproved entries expire after one idle hour, with a maximum 256. A full table rejects new entries without evicting approvals in progress. Pending approval is Gateway-signed and carried by the form, uses no server capacity and expires after ten minutes. MCP sessions bind their creation identity (Owner/delegated/OAuth application); other credentials receive 404, while the same app's refreshed token continues. Set `REACH_MCP_ALLOWED_ORIGINS` if the host sends Origin. Proxy `/.well-known/oauth-*` and `/oauth/*` to Gateway; repository Caddy already forwards the whole site.

## Method A: installed outputs

Generated configuration is `~/.config/reach/mcp.json`. Replace placeholder home paths below with real absolute paths. Merge `mcpServers.reach` into local client settings without removing other servers:

```json
{
  "mcpServers": {
    "reach": {
      "command": "/absolute/path/to/home/.reach/runtime/node/bin/node",
      "args": ["/absolute/path/to/home/.local/share/reach/mcp/dist/main.js"],
      "env": {
        "REACH_MCP_DEVICES_FILE": "/absolute/path/to/home/.config/reach/mcp-devices.json",
        "REACH_MCP_READY_POLL_MS": "1000"
      }
    }
  }
}
```

Engine installation always prepares independent `~/.reach/runtime/node` and uses absolute `bin/node` for MCP, independent of Homebrew/system Node. Update paths for other accounts/devices. Generation does not register it with an MCP client; that client's format/reload rules apply.

MCP initialization instructions and `list_devices` description explain the runtime location/purpose. Same-host Gateway/MCP may share it; selecting a remote device never uses remote Node as a local executable.

MCP selects its interpreter with `command`, not `REACH_NODE_BIN`. That variable is for [run-node.sh](node-runtime.md), not Rust Engine.

Keep client tokens in a separate private device JSON, not shared launcher configuration. Ensure the client process can read it and execute Node. Cloud-only clients unable to spawn local stdio cannot use this method.

## Method B: run from source

Build from repository root:

```bash
npm --prefix packages/reach-rpc ci --ignore-scripts
npm --prefix packages/grok-bot-mcp-connector run build
```

Compiler dependencies come from adjacent `reach-rpc`; the MCP package has no independent `npm ci` step. Its build also compiles RPC.

Example client configuration:

```json
{
  "mcpServers": {
    "reach": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/reach/packages/grok-bot-mcp-connector/dist/main.js"],
      "env": {
        "REACH_MCP_DEVICES_FILE": "/absolute/path/to/private/devices.json",
        "REACH_MCP_READY_POLL_MS": "1000"
      }
    }
  }
}
```

With installed Engine, use the actual absolute `~/.reach/runtime/node/bin/node`; otherwise find Node with `command -v node`. Never use `npm run build`, `npm start` or a verbose wrapper as stdio entry: stdout must contain only MCP JSON-RPC. Build separately first.

## Method C: a stable MCP-only runtime directory

A separate Mac/Linux client needs no Engine. Build with method B, save private Controller device configuration as `.reach/devices.json`, then copy runtime files:

```bash
mkdir -p "$HOME/.local/share/reach/mcp/dist" "$HOME/.config/reach"
chmod 700 "$HOME/.local/share/reach" "$HOME/.config/reach"
install -m 644 packages/grok-bot-mcp-connector/package.json \
  "$HOME/.local/share/reach/mcp/package.json"
for module in main config gateway server tools protocol invoker result version; do
  install -m 644 "packages/grok-bot-mcp-connector/dist/$module.js" \
    "$HOME/.local/share/reach/mcp/dist/$module.js"
done
install -m 644 packages/grok-bot-mcp-connector/dist/version.json \
  "$HOME/.local/share/reach/mcp/dist/version.json"
install -m 600 .reach/devices.json "$HOME/.config/reach/mcp-devices.json"
```

Preserve `package.json` `type: module`, every JS module and generated `dist/version.json`, not just the entry point. Runtime dependencies are Node standard library; do not copy node_modules. Optionally install private runtime with `python3 scripts/install-node-runtime.py` (Mac/Linux x64/arm64), then use method A's absolute local Node/entry/config paths. Stop the client-launched Connector before upgrade copies.

When Engine/client share a Mac, [Engine installer](engine.md) can install these files together.

## Private device configuration

The file must contain a nonempty JSON array:

```json
[
  {
    "id": "engine-a",
    "engineId": "engine-a",
    "gatewayUrl": "https://reach.example.com",
    "controllerToken": "<delegated-client-token-authorized-only-for-engine-a>"
  },
  {
    "id": "engine-b",
    "engineId": "engine-b",
    "gatewayUrl": "https://reach.example.com",
    "controllerToken": "<delegated-client-token-authorized-only-for-engine-b>"
  }
]
```

`id` is a nonempty unique client alias, not heartbeat authentication. It may match Engine ID as shown or differ; actual identity is bound by Gateway/Engine configuration.

Multiple entries may share Gateway using optional `engineId`; omission routes default Engine. See [Multiple devices](openwrt.md).

Prefer `REACH_MCP_DEVICES_FILE` and mode 600. Alternatively pass JSON via `REACH_MCP_DEVICES`; never set both. With neither, defaults are `local-engine` and `http://127.0.0.1:8787`, suitable only for loopback development.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `REACH_MCP_DEVICES_FILE` | None | Private device JSON path, preferably absolute |
| `REACH_MCP_DEVICES` | None | JSON device array, alternative to file |
| `REACH_MCP_TOOL_MODE` | `dynamic` | `dynamic` or `static` |
| `REACH_MCP_READY_TIMEOUT_MS` | `150000` | Total Engine-readiness budget |
| `REACH_MCP_READY_POLL_MS` | `200` | Poll interval; installer may set `1000` |
| `REACH_MCP_RENEW_SKEW_MS` | `60000` | Early lease-renewal window |
| `REACH_MCP_REQUEST_TIMEOUT_MS` | `35000` | Total HTTP request including body reading |

Times are positive integer milliseconds. Default 150-second readiness covers default 120-second idle heartbeat; leave connection margin even with shorter heartbeats.

## First use and tool lists

Dynamic initialization exposes `list_devices`, `get_versions`, `pick_device`, `list_workspaces`:

1. Call `list_devices`.
2. Call `list_workspaces` with `{"deviceId":"engine-a"}`. Connector selects, opens and waits for ready, returning workspace/execution names.
3. Connector emits a tools-list change. Refresh to see `fs.read`, `fs.write`, `fs.edit`, `fs.list`, `fs.glob`, `fs.stat`, `fs.grep`, `process.run`, `process.status`, `process.logs`, `process.stop`, `process.list`, `session.close`.
4. Use discovered names. Alternatively connect with `pick_device`, then discover.
5. Finish with `session.close` to return to selection.

Assuming discovered file workspace `notes`, example file-tool arguments:

```json
{
  "workspace": "notes",
  "path": "notes/example.txt",
  "content": "Reach MCP example",
  "mode": "create"
}
```

These are `fs.write` arguments; `mode: create` requires a nonexistent target. `fs.edit` uses `oldString`, `newString`. Write/edit automatically request path/method grants, without manual authorization calls; this is not human approval and cannot expand policy. See [Client permissions](client-access.md) for mapping, errors, ownership and atomic-write/revocation boundaries.

If the client never refreshes dynamic lists, add `"REACH_MCP_TOOL_MODE": "static"` to env and restart Connector. Static lists file/process tools immediately; every file/process/close operation needs `deviceId`, e.g.:

```json
{
  "deviceId": "engine-a",
  "workspace": "notes",
  "path": "notes/example.txt"
}
```

Static file tools and `process.run` select/open/reuse by deviceId. `process.status/logs/stop/list` access tasks owned by the current selected session only, never connecting elsewhere; unmatched ownership returns `PROCESS_NOT_FOUND`. `session.close` closes only the selected owned session; another configured device yields `closed: false`, `owned: false` without opening one.

## Lifecycle and checks

Before file tools/process.run, Connector checks sessions and rebuilds/renews as needed. Observation/control retain task ownership. Switching devices first closes the old session. After stdin closes, Connector finishes received requests before closing owned sessions.

Status may retry temporary network failures within budget. File RPC, grants and session mutations are never automatically replayed. Confirm results after lost write responses. Do not let clients compete for one Engine; distinct Engines are isolated.

A manually started `node .../dist/main.js` may print nothing while awaiting stdio input. Diagnostics use stderr. Run installed-MCP checks from [Verification](verification.md). Files live in Engine workspaces; Connector reads only its private config.

## Script tasks

HTTP `process_run/status/logs/stop/list` require deviceId. Stdio dotted methods use selected device dynamically or require deviceId statically. Gateway routes to target Engine/private Node. Execution defaults off; see [Script tasks](processes.md).

HTTP `session_close` retains `closedDeviceId` and returns `closed`/`owned`: true/true for closing its own session, false/false for idempotent no-session calls. Foreign/replacement sessions return `ENGINE_BUSY` and stay open.
