## Context

Reach today is a single-host proof: a TypeScript Gateway binds `127.0.0.1`, owns `~/.reach/workspace`, and dispatches `fs.*` on the WebSocket while a Rust `session-client` connects once and exits. Heartbeat already describes an Engine that polls for work, but the implementation never became a service and the filesystem ended up on the wrong host for Model B.

Model B (this change): Gateway is the central control plane; Engine is a resident agent on ordinary machines; workspace and `fs.*` execution live on the Engine; after upgrade, Gateway drives requests and Engine replies.

Constraints carried forward: loopback-first development, in-memory session/grant state, no TLS or remote auth yet, single live session.

## Goals / Non-Goals

**Goals:**

- Make Engine a long-running heartbeat + session service.
- Move filesystem execution to the Engine host/workspace.
- Reverse session RPC direction: Gateway sends requests; Engine responds; Engine sends `job.done`.
- Keep Gateway as issuer of session tokens and write grants.
- Provide a local HTTP way (`POST /session/rpc`) for controllers/tests to drive Engine filesystem work through the Gateway.
- Preserve `127.0.0.1` two-process integration proof.

**Non-Goals:**

- Public bind addresses, TLS terminators, or shared-secret/mTLS authentication.
- Multi-device registry or per-device `session-wanted` targeting.
- Grok Bot plugin UI.
- Persisting grants, cursors, or session state across process restarts.
- Dual-mode compatibility with Engine→Gateway filesystem requests.

## Decisions

### Treat Model B as an evolutionary replacement

Replace the inverted proof rather than feature-flag both RPC directions. Callers and tests update to Gateway-driven `/session/rpc`. Rollback is revert + restart; in-memory state is disposable.

Alternative considered: dual-mode compatibility. Rejected because it freezes the wrong ownership model and doubles session protocol surface.

### Engine is a Rust resident binary in `crates/reach-rpc`

Replace one-shot `session-client` with an `engine` (or renamed) binary that:

1. Loops on `POST /heartbeat`
2. Sleeps `intervalSeconds`
3. On credentials, connects to `wssUrl` with `token`
4. Serves inbound RPC against a Rust workspace implementation
5. Sends `job.done` when the controller/job path completes (integration stub: after explicit done signal from test harness, or when Gateway closes after proxy traffic—prefer Engine sending `job.done` when instructed by a small control message or when the integration client finishes its scripted requests and tells the Engine via a `session.complete` request from Gateway)

For the first integration path: Gateway (or test via `/session/rpc`) performs needed filesystem calls, then Gateway sends a session control request such as `session.complete` / or the test POSTs an endpoint that asks the Engine to emit `job.done`. Simplest: keep Engine sending `job.done` when it receives a Gateway message `{ "type": "session.close" }` or a dedicated RPC method `session.complete` with empty params. Prefer a non-fs RPC method `session.complete` forwarded like other requests so the Engine owns the completion signal.

Alternative considered: Node Engine reusing `WorkspaceFilesystem`. Rejected for Model B edge deployment; Rust remains the portable agent language already started in-tree.

### Port workspace semantics into Rust on the Engine

Implement Engine-side workspace logic in Rust aligned with existing Zod/Serde DTOs and limits (containment, revisions, grants field presence, glob/grep bounds, cursors). TypeScript `WorkspaceFilesystem` remains as reference/tests until parity is proven, then Gateway stops calling it on the session path.

Alternative considered: Engine shells out to a Node helper. Rejected as an extra runtime on every edge host.

### Gateway validates grants, then forwards mutations

Gateway continues to own `POST /grants` and the grant map. `POST /session/rpc` for `fs.write` / `fs.edit` validates grants before forward. Engine requires `permission.grantId` on mutations but only receives mutations the Gateway already checked. Engine does not maintain an independent grant store in this change.

Alternative considered: sync full grant table to Engine at session start. Deferred; adds invalidation traffic without benefit while Gateway is the only request originator.

### Add `POST /session/rpc` as the local controller seam

Until a Bot plugin exists, tests and curl need a Gateway HTTP entrypoint that:

- Requires a live Engine session
- Fills/binds `sessionId`
- Forwards the envelope over WebSocket
- Returns the Engine `response` / `error`

This keeps control-plane HTTP on Gateway and data-plane execution on Engine.

Alternative considered: only programmatic `createGateway` test hooks. Rejected; README/curl proof would disappear.

### Keep loopback listen defaults

Gateway remains `127.0.0.1` with `GATEWAY_PORT`. Engine defaults to `http://127.0.0.1:8787`. Topology is two processes on one host for now; host separation is a later bind/auth change without further RPC direction churn.

### Session idle timer measures Engine replies and Gateway traffic

Idle timeout remains Gateway-enforced on the socket. Gateway-originated requests reset idle the same way inbound Engine messages do today. Document that controllers must not open a session and idle for >60s without traffic.

## Risks / Trade-offs

- [Rust workspace port is large vs TypeScript reference] → Port behind the same contract tests/fixtures; gate merge on method parity used by integration proof first, then full method list.
- [Breaking existing gateway session tests that send Engine→Gateway fs requests] → Rewrite tests to connect an Engine (or fake Engine) and drive `/session/rpc`.
- [Grant check only on Gateway could be bypassed if something else spoke the Engine protocol] → Acceptable under loopback single-session trust; remote auth is an explicit follow-up.
- [Two-process local DX is heavier than one gateway] → Document start order: Gateway, then Engine, then `session-wanted` + `/session/rpc`.
- [`sessionId` must stay on heartbeat responses] → Keep emitting it with credentials so Engine can bind envelopes even when `/session/rpc` fills it for HTTP callers.

## Migration Plan

1. Land specs/design/tasks (this change).
2. Implement Engine loop + Rust workspace enough for read/list/stat; add Gateway `/session/rpc` and remove Gateway session filesystem dispatch.
3. Complete write/edit/glob/grep/cursor parity on Engine; point grants through Gateway validation + forward.
4. Update README to two-process Model B proof on loopback.
5. Rollback: revert commits and run previous one-shot client only if needed; no persistent data migration.

## Open Questions

- Exact name of the completion signal method (`session.complete` vs Gateway-only close after HTTP “end session”) — default to Engine-emitted `job.done` triggered by Gateway sending `{ "type": "job.finish" }` or RPC `session.complete`.
- Whether TypeScript `WorkspaceFilesystem` is deleted in this change or kept as a non-session reference until a later cleanup change — default to stop using it on the session path, keep module if unit tests still need it, delete only when unused.
