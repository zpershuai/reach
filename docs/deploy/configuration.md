# Configuration, domains and credentials

English | [简体中文](configuration_cn.md)

## Deployment parameters and prerequisites

| Item | Example | Requirement |
| --- | --- | --- |
| Gateway URL | `https://reach.example.com` | Dedicated domain root; no `/reach` prefix |
| VPS SSH | `deploy@gateway.example.com` | Write access to the release directory and Docker/Caddy administration |
| Release directory | `/srv/reach` | Keep one Compose project directory to avoid duplicate services |
| Engine ID | `engine-a` | Must match on Gateway and Engine |
| Workspace | `default:$HOME/.reach/workspace` | Put the actual absolute path in configuration, not literal `$HOME` |
| Development tools | Node.js 24, npm, stable Rust, Python 3 | CI covers Node 24 on macOS/Linux; Mac background installation requires a logged-in GUI user |
| VPS tools | Docker Engine, Compose plugin, Caddy | Install on the target server first |

Check `node --version`, `npm --version`, `cargo --version` and `python3 --version` locally; check `docker version`, `docker compose version` and `caddy version` on the VPS. Build the Engine for its target platform; a Mac binary cannot run on Linux.

Point the domain's A record to the VPS. Any AAAA record must reach the same service. Allow inbound 80/443 for HTTPS and Caddy certificate validation. Reuse an existing Caddy installation rather than starting another proxy on those ports.

## Credential responsibilities

| Credential | Storage | Purpose |
| --- | --- | --- |
| Owner Controller token | Gateway env and trusted management configuration | Data-plane access to every Engine/workspace |
| Delegated token | Private everyday MCP settings | Explicit Engine/workspace/read/write/execute policy and expiry |
| OAuth token | Approved application's private settings | Current policy; review legacy-global applications |
| Engine token | Gateway env and Mac Engine env | Heartbeat authentication bound to the Engine ID |
| session token | Gateway heartbeat response, briefly held by Engine | One WSS session; valid for 30 seconds and usable once |
| grant ID | Gateway memory, briefly held by client | File grants bind workspace, path and write methods. Process grants bind sessionId plus execute (workspace/script/launchId) or control (processId). Both expire, currently after five minutes |

The two long-lived tokens must differ and each contain at least 32 characters. Generate 32 random bytes as 64 hexadecimal characters for each. Engine tokens accept only ASCII letters, digits and `-_.`, so hexadecimal is suitable. Production TLS must validate certificates.

Controller token holders can read/write configured workspaces and request grants; workspace boundaries are part of deployment permissions. Use scoped delegated/OAuth tokens for everyday MCP access and keep Owner access for trusted administration. Engines use only Engine tokens. See [Client permissions](client-access.md) for fields, the single-owner boundary, lifecycle, legacy review and rollback.

## Generate private configuration once

Run this optional one-time generator from the repository root. Reuse existing `.reach/` configuration. It exits if any target exists to avoid accidental credential rotation. It only writes local configuration; it does not upload, install or start services.

```bash
python3 - <<'PY'
import json
import secrets
import shlex
from pathlib import Path

gateway_url = 'https://reach.example.com'
engine_id = 'engine-a'
workspace = str(Path.home() / '.reach/workspace')
directory = Path('.reach')
names = ['deployment.json', 'gateway.env', 'engine.env', 'devices.json', 'engines.json']
if any((directory / name).exists() for name in names):
    raise SystemExit('Deployment configuration already exists: reuse it or back it up separately first. No new credentials generated.')
directory.mkdir(mode=0o700, exist_ok=True)
directory.chmod(0o700)
controller = secrets.token_hex(32)
engine = secrets.token_hex(32)
deployment = dict(gatewayUrl=gateway_url, engineId=engine_id,
                  controllerToken=controller, engineToken=engine,
                  workspaceRoot=workspace)
gateway_env = dict(REACH_CONTROLLER_TOKEN=controller,
                   REACH_PUBLIC_ORIGIN=gateway_url,
                   REACH_ENGINE_TOKEN=engine, REACH_ENGINE_ID=engine_id,
                   REACH_HEARTBEAT_INTERVAL_SECS='15',
                   REACH_ENGINES_FILE='/run/reach/engines.json')
engine_env = dict(REACH_GATEWAY_URL=gateway_url,
                  REACH_ENGINE_TOKEN=engine, REACH_ENGINE_ID=engine_id,
                  REACH_WORKSPACE_ROOTS='default:' + workspace)
contents = {
    'engines.json': '[]\n',
    'deployment.json': json.dumps(deployment, indent=2) + '\n',
    'gateway.env': ''.join(f'{key}={value}\n' for key, value in gateway_env.items()),
    'engine.env': ''.join(f'{key}={shlex.quote(value)}\n' for key, value in engine_env.items()),
    'devices.json': json.dumps([dict(id=engine_id, engineId=engine_id, gatewayUrl=gateway_url,
                                    controllerToken=controller)], indent=2) + '\n',
}
for name, content in contents.items():
    target = directory / name
    with target.open('x') as output:
        target.chmod(0o600)
        output.write(content)
print('Generated five private configuration files under .reach/; credentials were not printed.')
PY
```

`.reach/deployment.json` is private verification configuration containing the URL, Engine ID, both tokens and actual absolute workspace path. Keep it on the verification machine, outside Docker images, documentation and shared client configuration.

Git ignores `.reach/`, `deploy/*.env` and the real `deploy/engines.json` registry; Docker build context excludes them too. Check permissions and staging when keeping configuration elsewhere. Back up private configuration and workspaces to private storage.

## Gateway environment variables

| Variable | Default | Deployment notes |
| --- | --- | --- |
| `GATEWAY_HOST` | `127.0.0.1`; image: `0.0.0.0` | Use the image default in Compose; publish only to host loopback |
| `GATEWAY_PORT` | `8787` | Integer 1–65535; update mappings and health checks together |
| `REACH_CONTROLLER_TOKEN` | None | Set together with the following two variables |
| `REACH_ENGINE_TOKEN` | None | Must differ from Controller token |
| `REACH_ENGINE_ID` | None | Unique default Engine ID, e.g. `engine-a` |
| `REACH_ENGINES_FILE` | None | Private additional-Engine registry; Compose mounts `/run/reach/engines.json` |
| `REACH_HEARTBEAT_INTERVAL_SECS` | `120` | Positive seconds; `15` is an example |
| `REACH_HTTP_LOG` | Off | `1` logs request paths, statuses and durations |
| `REACH_DATA_DIR` | Unset; console disabled | Writable persistent directory for `reach.db`, WAL, administration, devices and audit. Recommended directory `0700`, database `0600`; unwritable storage prevents startup |
| `REACH_PUBLIC_ORIGIN` | HTTP origin of loopback listener | Full external origin, e.g. `https://gateway.example.com`, without path/trailing slash. Required for console on non-loopback listeners; also MCP OAuth issuer and resource base (`<origin>/mcp`) |
| `REACH_ADMIN_SETUP_TOKEN` | Generated in `admin-setup-token` in the data directory when no administrator exists | Private `0600` file, never logged; safely reused, removed after setup, not created for an existing administrator. May be set explicitly in private env; see the console guide |
| `REACH_TRUSTED_PROXIES` | Empty | Comma-separated proxy IPs/CIDRs, e.g. `192.0.2.10,198.51.100.0/24`. `X-Forwarded-For` is used for rate limiting only when the socket peer is trusted; choose the smallest actual proxy range |
| `REACH_AUDIT_RETENTION_DAYS` | `30` | Integer `1`–`365`; invalid values fail before listening. Also editable in console |
| `REACH_MCP_ALLOWED_ORIGINS` | Empty | Comma-separated complete HTTP MCP Origins. Requests with Origin are denied by default; cloud clients without it work normally |
| `REACH_MCP_SESSION_IDLE_MS` | `300000` | HTTP MCP idle expiry, closing its Engine sessions |
| `REACH_MCP_RESPONSE_TIMEOUT_MS` | `25000` | Response budget covering body reading, queueing and execution |
| `REACH_MCP_MAX_SESSIONS` | `128` | Total HTTP MCP sessions, including pending cleanup |
| `REACH_MCP_MAX_QUEUE` | `16` | Per-session total of body reads, queued and running requests; returns 429 when full |

Partial configuration of the three authentication variables fails startup. Authentication is mandatory on non-loopback listeners. Listening on all container interfaces does not expose VPS ports: Compose's `127.0.0.1:28787:8787` controls that boundary.

HTTP MCP and REST Controller share `REACH_CONTROLLER_TOKEN`; there is no separate MCP token. HTTP times/counts must be positive safe integers. These limits are separate from stdio readiness/request settings.

## Engine environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `REACH_GATEWAY_URL` | `http://127.0.0.1:8787` | Use HTTPS publicly; mutually exclusive with the command-line URL |
| `REACH_ENGINE_TOKEN` | None | Required with HTTPS |
| `REACH_ENGINE_ID` | `reach-engine` | Must match Gateway configuration |
| `REACH_WORKSPACES_FILE` | Unset | Local workspace JSON, mutually exclusive with both workspace environment variables; see [dynamic workspaces](engine.md) |
| `REACH_WORKSPACE_ROOTS` | Actual path corresponding to `default:~/.reach/workspace` | Comma-separated `name:absolute-path` roots |
| `REACH_CONNECTION_TIMEOUT_SECS` | `15` | Connection timeout |
| `REACH_RPC_DEADLINE_SECS` | `30` | RPC execution limit |
| `REACH_LEASE_SECS` | `300` | Engine lease limit |
| `REACH_IDLE_SECS` | `300` | Inactive-session limit |
| `REACH_ROTATION_SECS` | `28800` | Maximum continuous connection: eight hours |

Timeouts are positive integer seconds. Raising Engine limits does not raise Gateway limits. Bash sources `engine.env`; quote values containing spaces and treat the file as trusted configuration. Avoid commas in root paths because roots use comma separators.

See [mcp.md](mcp.md) for all MCP environment variables.

## Domain and authentication boundaries

Gateway serves its control interface over one HTTPS domain. Engines use that origin for HTTPS/WSS; no per-Engine domain is required.

This implementation uses independent bearer tokens and in-memory grants. It does not implement Ed25519 signed authorization or Agent assertions. When migrating from another protocol, check authentication, clients and configuration compatibility separately; changing the proxy target does not migrate credentials or sessions.

## Optional update environment variables

Engine and Gateway share these settings. Omitting them preserves existing installation behavior without GitHub requests. Other update configuration is validated only when enabled with `1` or `true`; invalid enabled settings fail before the first heartbeat/listen.

| Variable | Default | Meaning |
| --- | --- | --- |
| `REACH_UPDATE_ENABLED` | Off | Enable with `1` / `true`; other values keep it off |
| `REACH_UPDATE_REPO` | None | Required `owner/repo`; official releases use `zpershuai/reach` |
| `REACH_UPDATE_INTERVAL_SECS` | `3600` | Integer seconds, minimum `60`; Gateway must fit Node's timer range |
| `REACH_UPDATE_GITHUB_TOKEN` | None | Optional token in private env |
| `REACH_UPDATE_GITHUB_TOKEN_FILE` | None | Alternative private token file; trims surrounding whitespace |
| `REACH_UPDATE_BACKEND` | `host` | `host` or `compose`. Host Engine replaces its binary; both Gateway modes use a host helper |
| `REACH_UPDATE_REQUEST_DIR` | None | Required for Compose Engine and every updating Gateway; writable by process, readable by helper |

Example container settings for ignored local `gateway.env`:

```dotenv
REACH_UPDATE_ENABLED=true
REACH_UPDATE_REPO=zpershuai/reach
REACH_UPDATE_BACKEND=compose
REACH_UPDATE_REQUEST_DIR=/run/reach/update
```

Compose mounts `deploy/update/` there. First create it and install the host helper using [Operations](operations.md). Mount a container token file separately read-only, with permissions allowing the container user to read it. Configure the helper's token separately: host helpers cannot read container-only paths. Never commit tokens, private repository owners or installation directories.

For host Engine, first install the new launcher with health recovery, then set enable/repository. Its directory must support service-user writes and atomic replacement. Do not bypass the launcher with internal guard variables. Compose Engine needs its own backend/request directory; its helper uses `REACH_UPDATE_COMPOSE_FILE` for the existing Compose file, `REACH_UPDATE_ENGINE_SERVICE` (default `engine`) and `REACH_UPDATE_ENGINE_BINARY_PATH` (default `/usr/local/bin/engine`). Preserve env, workspaces and Node runtime.

## Workspace configuration sources

Engine chooses explicit `REACH_WORKSPACES_FILE`, then either `REACH_WORKSPACE_ROOTS` / `REACH_PROCESS_WORKSPACES`, then existing `~/.reach/workspaces.json`, then built-in `default`. An explicit file with either environment variable is an error, even if the variable is empty. Environment mode does not reload; file mode does not create missing roots.

Example: `{"workspaces":{"docs":{"path":"/home/example/documents","process":false}}}`. Only `workspaces`, each `path` and optional `process` are accepted. Require at least one nonempty name and an existing absolute directory; unknown keys are rejected. Keep Gateway settings and credentials in private service env, never workspace JSON.

File mode polls every two seconds for changed content. Unix `SIGHUP` requests immediate reload on the next loop. A fully valid file applies atomically between requests; invalid, unreadable or deleted files retain the last valid configuration and emit `WORKSPACE_RELOAD_FAILED` without content. Prefer temporary-file rename. Removing/changing roots invalidates cursors and stops affected processes; disabling execution stops processes too. After the ready refresh, clients can call `list_workspaces` again. Upgrade Gateway to 0.7.2 first, then Engine to 0.3.2 for hot reload. Old Gateways cannot revoke old grants on root replacement: use a new name instead. See [Engine](engine.md) for the complete format and behavior.
