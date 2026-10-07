# Reach

Gateway, device Engine, and a generic MCP connector. Protocol: reach-rpc/1.0.

Deployment: [three-component deployment guide](docs/deploy/README.md). MCP clients: [installation instructions](docs/deploy/mcp.md). Validation: [deployment checklist](docs/deploy/deployment-checklist.md).

MCP, Engine and Gateway have independent release versions, exposed through `--version`, Gateway health/session status and the MCP `get_versions` tool. See [component versions and upgrades](docs/deploy/versions.md).

Each Engine installation automatically installs a pinned, checksum-verified Node.js runtime under `~/.reach/runtime/node` for Gateway and MCP processes on that host. This is an installation policy; the Rust Engine does not execute or require Node.js. The generated MCP configuration uses its stable `bin/node` path. After building, `sh scripts/start-gateway.sh` starts a local Gateway with this runtime. It can also be installed independently with `python3 scripts/install-node-runtime.py`. See [runtime installation and execution boundaries](docs/deploy/node-runtime.md).

**Model B topology:** the Gateway is the single Agent-facing control plane; a long-running Engine Runtime on the device owns the workspace and executes `fs.*` RPC. Local development uses loopback (`127.0.0.1`) with two processes.

## Two-process loopback deployment

Terminal 1 — start the Gateway (default `127.0.0.1:8787`):

```bash
cd packages/reach-rpc
npm run gateway
```

Terminal 2 — start the Engine Runtime (heartbeats the Gateway; default workspace `~/.reach/workspace`):

```bash
cargo run -p reach-rpc --bin engine -- http://127.0.0.1:8787
```

Optional Engine configuration (environment variables):

```bash
REACH_ENGINE_ID=reach-engine            # non-empty Engine identifier advertised in session.ready
REACH_WORKSPACE_ROOTS=default:/srv/reach,fixture:/tmp/fixture
REACH_CONNECTION_TIMEOUT_SECS=15        # bound on session setup/readiness
REACH_RPC_DEADLINE_SECS=30              # default per-request deadline
REACH_LEASE_SECS=300                    # Engine-side lease ceiling
REACH_IDLE_SECS=300                     # session inactivity bound
REACH_ROTATION_SECS=28800               # continuous connection max age (8h)
```

The Engine accepts exactly one configured Gateway origin: plaintext HTTP on loopback for local development, or verified HTTPS/WSS with `REACH_ENGINE_TOKEN` for remote deployment. A second origin, invalid scheme, invalid timeout, or empty Engine identifier fails fast before any heartbeat.

## Agent session lifecycle

One Agent controls one interactive Engine session through the Gateway. The session is a renewable lease: the Agent  **opens** it, **renews** it before its lease expires, and **closes** it when done. The Engine independently enforces its own bounds (`lease expiry`, `idle` timeout, `rotation`) as a fail-safe.

Terminal 3 — open a session, wait for readiness, drive RPC, renew, and close:

```bash
# Open a session (one session at a time).
curl -sS -X POST http://127.0.0.1:8787/session/open \
  -H 'content-type: application/json' --data '{}'
# {"wanted":true,"status":"wanted","sessionId":"..."}

# Wait until the Engine connects and the Gateway logs "Reach session ready".

curl -sS http://127.0.0.1:8787/session/status
# {"wanted":false,"status":"ready","sessionId":"...","leaseExpiresAt":"...","closureReason":null}

curl -sS -X POST http://127.0.0.1:8787/session/rpc \
  -H 'content-type: application/json' \
  --data '{"requestId":"r1","method":"fs.read","params":{"workspace":"default","path":"notes/today.txt","maxLines":20}}'

# Mutation requires a Gateway-issued grant (validated before forward),
# which the Engine's Authorizer trusts on the bound session.
curl -sS -X POST http://127.0.0.1:8787/grants \
  -H 'content-type: application/json' \
  --data '{"workspace":"default","path":"notes/today.txt","methods":["fs.write"]}'
# {"grantId":"...","expiresAt":"..."}

curl -sS -X POST http://127.0.0.1:8787/session/rpc \
  -H 'content-type: application/json' \
  --data '{"requestId":"w1","method":"fs.write","params":{"workspace":"default","path":"notes/today.txt","content":"hi","mode":"overwrite"},"permission":{"grantId":"<grantId>"}}'

# Renew before the lease expires (advised every ~60s for a 5-minute lease).
curl -sS -X POST http://127.0.0.1:8787/session/renew \
  -H 'content-type: application/json' --data '{}'
# {"sessionId":"...","leaseExpiresAt":"..."}

# Close the session (the normal success path).
curl -sS -X POST http://127.0.0.1:8787/session/close \
  -H 'content-type: application/json' --data '{}'
```

`POST /session-wanted` with `{"wanted":true}` / `{"wanted":false}` remains a legacy alias for open/close.

Control API summary:

| Endpoint | Method | Meaning |
| --- | --- | --- |
| `POST /session/open` | — | Request the selected Engine session |
| `GET /session/status` | — | Session state (`none`, `wanted`, `pending`, `connecting`, `ready`, `closing`) plus lease expiry and last closure reason |
| `POST /session/renew` | — | Extend the live session lease (bounded by Gateway/Engine policy) |
| `POST /session/close` | — | Request fast close; stops new RPC once draining begins |
| `POST /session/rpc` | — | Forward one data-plane request to the ready Engine |
| `POST /heartbeat` | — | Engine lease acquisition / idle polling |

## Engine Runtime behavior

- While no session is wanted the Engine posts a heartbeat every **120s** by default; configure `REACH_HEARTBEAT_INTERVAL_SECS` to adjust it. Once a session is wanted, the next heartbeat returns interval **5** and a one-time session lease: `endpoint`, `token`, `sessionId`, and an absolute `leaseExpiresAt`. The token is single-use and expires after 30 seconds.
- The lease `endpoint` is a Gateway-relative path (`/session`); the Engine resolves it against its **configured** Gateway origin and refuses a lease that points anywhere else.
- After opening the WebSocket the Engine sends `session.ready` (protocol/version, Engine id, workspace names, supported methods). The Gateway forwards no data-plane request until it has seen a valid `ready`.
- Tools execute serially on one worker while the Runtime continues receiving close/renew control messages. Close, lease expiry, rotation, or the hard RPC execution timeout sets a cooperative cancellation flag, drops queued work, drains the worker, and then releases the session. An atomic mutation already past its commit boundary may finish.
- The Engine is the executor and never originates data-plane `request` envelopes to the Gateway. It replies to each request with a matching `response` or `error`.
- On Agent close, lease expiry, idle timeout, rotation, or transport failure the Engine emits `session.closed` with a machine-readable reason, drains, and returns to heartbeat. A session is never resumed with its cursors or pending work.

### Runtime policy defaults

| Bound | Default |
| --- | --- |
| Connection setup / readiness | 15 s |
| RPC deadline | 30 s |
| Session lease (renewable) | 5 min |
| Idle (no RPC, renewal, or control) | 5 min |
| Continuous connection rotation | 8 h |

These are Engine **hard maxima**: both the initial lease and every renewal are capped by the Engine policy. Plaintext HTTP origins and their resolved addresses must be loopback; remote connections use verified TLS.

### Closure reasons

| Reason | Meaning |
| --- | --- |
| `agent_requested` | Agent/Gateway requested close |
| `session_complete` | Legacy `session.complete` translates to a close |
| `lease_expired` | No valid renewal before the lease expired |
| `idle_timeout` | No activity within the idle bound |
| `rotation` | Continuous connection reached the max age |
| `disconnected` | Transport closed unexpectedly |
| `connection_failed` / `policy_error` / `rpc_timeout` | Setup or policy failures |

## Session control protocol

The Gateway↔Engine WebSocket carries control messages and data-plane envelopes:

- Control: `session.ready`, `session.renew`, `session.close`, `session.closed` (each carries a non-empty `sessionId`; `renew` includes an absolute `leaseExpiresAt`; `close`/`closed` include a reason).
- Data plane: `request` / `response` / `error` with the `reach-rpc/1.0` envelope.

`tool.call { name, arguments }` is accepted only as a **single-level** compatibility adapter: it is canonicalized to a direct method before authorization and Tool dispatch. Nested, malformed, or depth-exhausted `tool.call` is rejected as `INVALID_PARAMS` and never reaches a Tool.

## Migration from short-job completion

`session.complete` and the `job.done` close signal previously defined the ordinary success path of a session. They are retained **only** for compatibility during migration:

- A `session.complete` request is answered `{ok:true}` and translated to an Engine-requested close (`session.closed` with reason `session_complete`).
- The Gateway also still accepts a legacy `job.done` message and treats it as a close.

New Agents must use explicit session control (`/session/open`, `/session/renew`, `/session/close`) and renewal. The compatibility path will be removed after Gateway/Engine/Agent integration tests rely on explicit control.

## Gateway hardening

HTTP JSON bodies are limited to 64 KiB and WebSocket text messages to 1 MiB. Every RPC request must be a complete `reach-rpc/1.0` envelope; controllers may omit `sessionId` on `POST /session/rpc` and the Gateway binds the live session id. Write grants are validated before forward (issuance, path scope, method scope, expiry) and cannot be bypassed by nesting `tool.call`.

## Multiple Engines and remote MCP

One Gateway can manage multiple registered Engines, each with its own credential, session, lease, grants and RPC state. Controller requests select an Engine with `?engineId=...`; requests without it target the default Engine. MCP device entries use `engineId` to route through a shared Gateway. See [OpenWrt and multi-device deployment](docs/deploy/openwrt.md).

Remote MCP clients connect to the same Gateway's HTTPS `/mcp` using the Controller token. The endpoint exposes static underscore filesystem tools, discovers registered Engines and returns promptly while idle devices connect. HTTP MCP sessions have identity-bound ownership, bounded requests, and DELETE/idle cleanup. Desktop stdio clients remain supported. See [MCP installation](docs/deploy/mcp.md) and the [Grok Bot plugin](grok-bot-plugin/README.md).


## RPC deadlines and retry behavior

The Gateway stamps each forwarded request with optional RFC3339 `deadlineAt`, bounded by its RPC timeout and any earlier caller deadline. That deadline includes Gateway processing and Engine queue time. The Engine converts the remaining budget to a monotonic deadline and caps it by Runtime and Tool policy; validation never restarts the budget. An expired queued write does not execute. A shorter caller or Tool deadline returns `DEADLINE_EXCEEDED` without discarding unrelated queued work; the Gateway forwarding timeout and Engine hard execution bound still close unresponsive sessions. Pending RPCs and running Tools count as activity, even if an idle timeout is shorter than the execution bound.

Cancellation is cooperative. A filesystem syscall already in progress, or an atomic write past its commit boundary, may finish even if the caller receives a timeout. A successful write Tool result retains its revision and is sent before teardown when the transport is still available; a committed write is not relabeled as a cancellation failure. A timeout is not proof that a write was rolled back. The MCP connector never automatically retries a forwarded RPC. Inspect the file revision before deciding whether to issue a new mutation.

Request-ID deduplication remembers the latest 65,536 IDs per connection. The Gateway retains the latest 4,096 uncertain IDs across session closure, including its own timeouts, Engine deadline/session-closed errors, and forwarded requests whose reply was lost on disconnect. These bounded, in-memory windows do not provide durable exactly-once execution after eviction or a process restart.

`POST /session/open` accepts an optional caller-selected `sessionId` and returns the intent id before the Engine connects. Retrying the same wanted/pending id preserves its token and lease; a different supplied id returns HTTP 409. `/session/renew` and `/session/close` accept an optional `sessionId`; a supplied id must match the pending or live session. Omitting it retains the legacy single-session API and repeated opens preserve the existing pending intent.

## Filesystem and lifecycle bounds

The Rust Engine uses no-follow, descriptor-relative access for reads, stats, directory enumeration, searches, and mutations on Unix. Reads reject non-regular targets without blocking on FIFOs and enforce the 8 MiB limit while reading, including files that grow after opening. Platforms without these primitives fail closed. Directory snapshots are bounded to 10,000 entries and traversal to 128 directory levels (`DIRECTORY_TOO_LARGE` / `DIRECTORY_TOO_DEEP`). Exhausted pagination snapshots are released; only unfinished queries consume the 32-cursor limit.

Runtime events use a 1,024-entry FIFO buffer. `drain_events()` consumes it. The production loop emits structured events as JSON and human-readable lifecycle messages to stdout, consuming the buffer after each outer Runtime step; active-session overflow evicts the oldest events.

## Validation

Install Node dependencies with `npm --prefix packages/reach-rpc ci --ignore-scripts`, then run `bash scripts/verify.sh`. The script checks Rust formatting, Rust tests, TypeScript Gateway tests, MCP tests including a real Rust Engine integration, and shared fixtures in both languages. CI runs this workflow on Linux and macOS with Node 24 and stable Rust. The TypeScript workspace filesystem is a test reference; production session execution uses the Rust Engine.
