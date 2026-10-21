# Reach protocol and runtime reference

Detailed behavior of the Gateway control API, the Engine Runtime and the `reach-rpc/1.0` session protocol. For an overview and quick start, see the [README](../../README.md).

## Components

The optional [Gateway console](../deploy/console.md) provides owner administration, device enrollment, live routing topology and metadata-only activity audit at `/console/`. Enable persistent storage with `REACH_DATA_DIR` and configure `REACH_PUBLIC_ORIGIN` before public binding.

MCP, Engine and Gateway have independent release versions, exposed through `--version`, Gateway health/session status and the MCP `get_versions` tool. See [component versions and upgrades](../deploy/versions.md).

Each Engine installation automatically installs a pinned, checksum-verified Node.js runtime under `~/.reach/runtime/node` for Gateway and MCP processes on that host. The Rust Engine uses this runtime for trusted workspace scripts when process execution is explicitly enabled; filesystem-only operation remains independent of Node. The generated MCP configuration uses its stable `bin/node` path. After building, `sh scripts/start-gateway.sh` starts a local Gateway with this runtime. It can also be installed independently with `python3 scripts/install-node-runtime.py`. See [runtime installation and execution boundaries](../deploy/node-runtime.md).

**Model B topology:** the Gateway is the single Agent-facing control plane; a long-running Engine Runtime on the device owns the workspace and executes `fs.*` RPC and opt-in trusted `process.*` tasks. Local development uses loopback (`127.0.0.1`) with two processes.

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

Control API summary:

| Endpoint | Method | Meaning |
| --- | --- | --- |
| `POST /session/open` | — | Request the selected Engine session |
| `GET /session/status` | — | Session state (`none`, `wanted`, `pending`, `connecting`, `ready`, `closing`) plus lease expiry and last closure reason |
| `POST /session/renew` | — | Extend the live session lease (bounded by Gateway/Engine policy) |
| `POST /session/close` | — | Request fast close; stops new RPC once draining begins |
| `POST /session/rpc` | — | Forward one data-plane request to the ready Engine |
| `POST /heartbeat` | — | Engine lease acquisition / idle polling |
| `POST /grants` | — | Issue scoped filesystem or process grants |
| `GET /healthz` | — | Gateway health and release version |
| `POST /mcp`, `DELETE /mcp` | — | Streamable HTTP MCP requests and session cleanup |

## Engine Runtime behavior

- While no session is wanted the Engine posts a heartbeat every **120s** by default; configure `REACH_HEARTBEAT_INTERVAL_SECS` on the **Gateway** to adjust its returned interval (the Engine follows `intervalSeconds`). Once a session is wanted, the next heartbeat returns interval **5** and a one-time session lease: `endpoint`, `token`, `sessionId`, and an absolute `leaseExpiresAt`. The token is single-use and expires after 30 seconds.
- The lease `endpoint` is a Gateway-relative path (`/session`); the Engine resolves it against its **configured** Gateway origin and refuses a lease that points anywhere else.
- After opening the WebSocket the Engine sends `session.ready` (protocol/version, Engine id, workspace names, supported methods). The Gateway forwards no data-plane request until it has seen a valid `ready`.
- A ready Engine may send `session.ready` again on the same `sessionId` and authenticated `engineId`. Gateway replaces `workspaces`, `processWorkspaces`, `workspaceGenerations` and `methods`, publishes `session.state`, and preserves pending RPCs. Mismatched bindings return `INVALID_PARAMS` without changing metadata.
- Optional `workspaceGenerations` maps non-empty workspace names to non-empty opaque identity tokens. A token stays stable while the canonical root stays the same and changes on repoint or removal followed by re-addition. Gateway revokes mutation and execution grants on removal or generation change, and execution grants when process access is disabled. If either ready message lacks generations, only removal can identify a changed workspace. Process control grants bind only to the original processId and remain until expiry; the Engine terminates affected owned processes. Older ready messages without this field remain valid; protocol version stays `1.0`.

Example (the shared `fixtures/session.ready.json` contract fixture; `futureField` demonstrates forward compatibility):

```json
{
  "type": "session.ready",
  "protocol": "reach-rpc",
  "version": "1.0",
  "sessionId": "session-1",
  "engineId": "reach-engine",
  "workspaces": [
    "default",
    "fixture"
  ],
  "methods": [
    "fs.read",
    "fs.list",
    "fs.stat",
    "fs.write",
    "fs.edit",
    "fs.glob",
    "fs.grep"
  ],
  "futureField": true,
  "workspaceGenerations": {
    "default": "generation-default",
    "fixture": "generation-fixture"
  }
}
```

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
| `shutdown` | Engine is shutting down and drains session-owned work |
| `connection_failed` / `policy_error` / `rpc_timeout` | Setup or policy failures |

## Session control protocol

The Gateway↔Engine WebSocket carries control messages and data-plane envelopes:

- Control: `session.ready`, `session.renew`, `session.close`, `session.closed` (each carries a non-empty `sessionId`; `renew` includes an absolute `leaseExpiresAt`; `close`/`closed` include a reason).
- Data plane: `request` / `response` / `error` with the `reach-rpc/1.0` envelope.

`tool.call { name, arguments }` is accepted only as a **single-level** compatibility adapter: it is canonicalized to a direct method before authorization and Tool dispatch. Nested, malformed, or depth-exhausted `tool.call` is rejected as `INVALID_PARAMS` and never reaches a Tool.

## Gateway hardening

HTTP JSON bodies are limited to 64 KiB and WebSocket text messages to 1 MiB. On `POST /session/rpc`, controllers may omit `type`, `protocol`, `version`, and `sessionId`; the Gateway fills `request`, `reach-rpc`, `1.0`, and the live session id before validating the request. Explicitly supplied fields must still be valid, and a supplied `sessionId` must match the live session. Every request forwarded to the Engine is a complete `reach-rpc/1.0` envelope. Write grants are validated before forward (issuance, path scope, method scope, expiry) and cannot be bypassed by nesting `tool.call`.

The Engine bounds serialized responses to the same 1 MiB, including JSON escaping and the request-id envelope. An oversized result returns `RESPONSE_TOO_LARGE` and keeps the session usable; reduce `fs.read` line ranges when possible. A single oversized line requires another means of retrieval. Edits check their final UTF-8 size before allocation. Atomic overwrite/edit preserves ordinary file permission bits; new files default to 0600, and special permission bits are cleared. Grant paths preserve filename whitespace exactly.

## Multiple Engines and remote MCP

One Gateway can manage multiple registered Engines, each with its own credential, session, lease, grants and RPC state. Controller requests select an Engine with `?engineId=...`; requests without it target the default Engine. MCP device entries use `engineId` to route through a shared Gateway. See [OpenWrt and multi-device deployment](../deploy/openwrt.md).

Remote MCP clients connect to the same Gateway's HTTPS `/mcp` using an explicitly scoped delegated/OAuth credential, or a trusted global Owner token. The endpoint exposes static underscore filesystem and process tools, discovers registered Engines and returns promptly while idle devices connect. HTTP MCP sessions have identity-bound ownership, bounded requests, and DELETE/idle cleanup. Desktop stdio clients remain supported. See [MCP installation](../deploy/mcp.md) and the [Grok Bot plugin](../../grok-bot-plugin/README.md).


## RPC deadlines and retry behavior

The Gateway stamps each forwarded request with optional RFC3339 `deadlineAt`, bounded by its RPC timeout and any earlier caller deadline. That deadline includes Gateway processing and Engine queue time. The Engine converts the remaining budget to a monotonic deadline and caps it by Runtime and Tool policy; validation never restarts the budget. An expired queued write does not execute. A shorter caller or Tool deadline returns `DEADLINE_EXCEEDED` without discarding unrelated queued work; the Gateway forwarding timeout and Engine hard execution bound still close unresponsive sessions. Pending RPCs and running Tools count as activity, even if an idle timeout is shorter than the execution bound.

Cancellation is cooperative. A filesystem syscall already in progress, or an atomic write past its commit boundary, may finish even if the caller receives a timeout. A successful write Tool result retains its revision and is sent before teardown when the transport is still available; a committed write is not relabeled as a cancellation failure. A timeout is not proof that a write was rolled back. The MCP connector never automatically retries a forwarded RPC. Inspect the file revision before deciding whether to issue a new mutation.

Request-ID deduplication remembers the latest 65,536 IDs per connection. The Gateway retains the latest 4,096 uncertain IDs across session closure, including its own timeouts, Engine deadline/session-closed errors, and forwarded requests whose reply was lost on disconnect. These bounded, in-memory windows do not provide durable exactly-once execution after eviction or a process restart.

`POST /session/open` accepts an optional caller-selected `sessionId` and returns the intent id before the Engine connects. Retrying the same wanted/pending id preserves its token and lease; a different supplied id returns HTTP 409. `/session/renew` and `/session/close` accept an optional `sessionId`; a supplied id must match the pending or live session. Omitting it retains the legacy single-session API and repeated opens preserve the existing pending intent.

## Filesystem and lifecycle bounds

The Rust Engine uses no-follow, descriptor-relative access for reads, stats, directory enumeration, searches, and mutations on Unix. Reads reject non-regular targets without blocking on FIFOs and enforce the 8 MiB limit while reading, including files that grow after opening. Platforms without these primitives fail closed. Directory snapshots are bounded to 10,000 entries and traversal to 128 directory levels (`DIRECTORY_TOO_LARGE` / `DIRECTORY_TOO_DEEP`). Exhausted pagination snapshots are released; only unfinished queries consume the 32-cursor limit.

Runtime events use a 1,024-entry FIFO buffer. `drain_events()` consumes it. The production loop emits structured events as JSON and human-readable lifecycle messages to stdout, consuming the buffer after each outer Runtime step; active-session overflow evicts the oldest events.

## Validation

Install tools with `npm ci --ignore-scripts` and RPC dependencies with `npm --prefix packages/reach-rpc ci --ignore-scripts`, then run `bash scripts/verify.sh`. The script gates pinned OpenSpec 1.14.1 strict validation, installer failure/rollback tests, Rust formatting/tests, TypeScript Gateway/MCP tests including real Engine integration, shared fixtures, and standalone MCP distribution smoke. CI runs on Linux and macOS with Node 24 and stable Rust. A separate Linux x86_64 job runs `bash scripts/verify-packaging.sh` to build the Gateway container and static Engine, compare two OpenWrt bundles, and execute bundled Node and its child in an isolated container. It requires Docker, musl-tools and the Rust musl target. See [deployment validation](../deploy/deployment-checklist.md) for platform gaps. The TypeScript workspace filesystem is a test reference; production session execution uses the Rust Engine.

Trusted script tools are `process.run`, `process.status`, `process.logs`, `process.stop`, and `process.list`. Dynamic stdio exposes them after device selection; HTTP uses underscore names with `deviceId`. See [process execution and recovery](../deploy/processes.md).

## Legacy compatibility

These paths exist only for older Agents and are scheduled for removal; new integrations should not use them.

### `/session-wanted`

`POST /session-wanted` with `{"wanted":true}` / `{"wanted":false}` remains a legacy alias for open/close.

### Short-job completion

`session.complete` and the `job.done` close signal previously defined the ordinary success path of a session. They are retained **only** for compatibility during migration:

- A `session.complete` request is answered `{ok:true}` and translated to an Engine-requested close (`session.closed` with reason `session_complete`).
- The Gateway also still accepts a legacy `job.done` message and treats it as a close.

New Agents must use explicit session control (`/session/open`, `/session/renew`, `/session/close`) and renewal. The compatibility path will be removed after Gateway/Engine/Agent integration tests rely on explicit control.

## Client policy and identity

REST, HTTP MCP and Connector calls share the Gateway's authenticated-principal facade. Owner tokens remain global; delegated and newly approved OAuth clients have explicit Engine/workspace permissions. Read maps to fs.read/list/stat/glob/grep, write to fs.write/edit, and execute to all process methods. Permissions are independent. Unknown or hidden Engine IDs return the same 404; cross-principal MCP session IDs return 404. Scoped discovery filters Engine/workspace/method/version/process metadata.

Session and task ownership use the authenticated principal, not caller labels or wire identity fields. File, execution and control grants bind principal, Engine and policy revision as well as their original scope/TTL. Issuance and forwarding both recheck current policy; nested tool.call is invalid. Grant issuance denial is HTTP 403, authenticated RPC policy denial is PERMISSION_DENIED, and invalid/expired/revoked credentials return 401. MCP reports ordinary tool failures through tool errors.

Rotation, revocation, delegated expiry and policy changes synchronously block old authority, revoke grants and drain owned sessions/tasks; expiry does not wait for another request. OAuth refresh preserves the same principal and current policy. Cleanup failures retain ownership for retry. Automatic MCP grants do not represent human approval. A write already forwarded to the Engine may cross its atomic commit boundary before revocation; read back revisions before retrying uncertain writes. Script execution has the Engine account's OS privileges and is not an OS sandbox.

See [client access](../deploy/client-access.md) for the management API, exact error shapes, legacy-global review and rollback procedure. No Engine wire-protocol change is needed for Gateway client policy.
