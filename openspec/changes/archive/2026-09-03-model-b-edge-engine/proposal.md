## Why

The current loopback proof co-locates Gateway and Engine and makes Engine a one-shot CLI that reads files from the Gateway workspace. The intended product topology is Model B: a central Gateway that schedules sessions, and a long-running Engine service on ordinary machines that owns the local workspace and executes filesystem RPC. Aligning roles and RPC direction now prevents further hardening and plugin work from cementing the inverted local-proof model.

## What Changes

- **BREAKING**: Move workspace filesystem execution from the Gateway process to the Engine process; Gateway no longer serves `fs.*` against a local root during a session.
- **BREAKING**: Reverse session RPC direction after WebSocket upgrade: Gateway (or a Gateway-attached controller) sends `reach-rpc/1.0` requests; Engine responds and eventually sends `job.done`.
- Replace the one-shot Rust `session-client` with a long-running Engine service that loops on Gateway heartbeats, opens a session when credentials are issued, and serves filesystem methods for that session.
- Keep Gateway as the control plane for `/heartbeat`, `/session-wanted`, `/grants`, and `/session` upgrade, including grant issuance and session binding.
- Add local `POST /session/rpc` so controllers and tests can forward `reach-rpc/1.0` requests through the Gateway to the live Engine and receive the Engine response.
- Preserve local `127.0.0.1` integration as the development path; do not add TLS termination, remote authentication, or multi-device persistent registry in this change.
- Update integration proofs and docs so a Gateway plus a separate Engine process demonstrate Model B on one host (still loopback) with files living under the Engine workspace.

## Capabilities

### New Capabilities
- `edge-engine-service`: Long-running Engine agent that heartbeats to a Gateway, accepts issued sessions, executes workspace filesystem RPC locally, and signals job completion.

### Modified Capabilities
- `gateway-session-transport`: Session transport becomes a Gateway-driven request channel to an Engine that executes work; Engine no longer issues filesystem requests to Gateway.
- `gateway-heartbeat`: Clarify that heartbeats come from a resident Engine service and that issued `wssUrl`/`token` are consumed by that service’s session loop.
- `gateway-write-grants`: Grants remain Gateway-issued, but Engine must enforce presented `permission.grantId` against grant metadata carried or validated for the live session (no forged local grants).
- `workspace-filesystem-rpc`: Filesystem operations are executed by the Engine against its configured workspace roots, not by the Gateway process.

## Impact

- TypeScript Gateway: remove (or stop using) in-session filesystem dispatch against Gateway-local `WorkspaceFilesystem`; add outbound request sending / response waiting on the live Engine WebSocket; keep HTTP control endpoints.
- Rust crate: grow from one-shot `session-client` into a resident Engine binary with heartbeat loop, WebSocket session server-role for RPC handling, and a Rust (or FFI-backed) workspace implementation aligned with existing DTOs.
- Specs and README: replace “local gateway owns workspace” wording with Model B roles; mark prior Engine→Gateway fs direction obsolete.
- Out of scope: public bind addresses beyond current loopback defaults, TLS, shared-secret auth, multi-device session targeting, Grok Bot plugin UI.
