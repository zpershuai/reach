## Why

Model B left several hardening gaps: Rust workspace writes reopened a symlink TOCTOU race that TypeScript closed with descriptor-relative I/O; the Gateway’s 1 MiB WebSocket limit is enforced only after full buffering; Engine sessions can leak cursors on abnormal disconnect; Gateway and Engine disagree on nested `tool.call`; and RPC timeouts abandon the HTTP waiter while Engine work and unbounded pending RPCs keep running. These break containment, session isolation, and caller expectations under hostile or flaky conditions.

## What Changes

- Restore TOCTOU-safe workspace mutations in the Rust Engine using openat/`O_NOFOLLOW` (or equivalent descriptor-relative) descent, temp create, and rename through verified parent descriptors—matching the TypeScript workspace guarantee.
- Enforce the 1 MiB WebSocket text limit at the `ws` layer via `maxPayload` so oversized frames are rejected before full application buffering.
- Clear session-scoped cursors on every Engine session exit path (including read/send failures) via RAII-style cleanup so a later session cannot resume another session’s cursors.
- Make nested `tool.call` behavior consistent: Gateway rejects nested `tool.call` with `INVALID_PARAMS` before grant matching (so the response code never depends on grant state), while single-level `tool.call` remains allowed and is still unwrapped for grant checks; Engine continues to reject nested `tool.call`.
- On `/session/rpc` timeout, close the live session WebSocket (aborting in-flight Engine work) and reject further pending waiters; cap concurrent pending RPCs at 16 and return 503 when the cap is exceeded; retain timed-out `requestId`s in a bounded set that survives session teardown so a retried mutation cannot be re-applied.
- Harden the descriptor mutation path found by review: mutation reads open non-regular targets with `O_NONBLOCK` (no engine stall on FIFOs/devices), a racing `mkdirat` `EEXIST` re-opens instead of failing closed, the final-component symlink check is restored immediately before `renameat`, parent directories are created only after all checks pass (failed mutations leave no tree changes), and unix filenames containing backslash remain addressable.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `workspace-filesystem-rpc`: Require descriptor-relative, no-follow mutations that close the symlink replacement race; reject nested `tool.call`; require cursors cleared on any session teardown.
- `gateway-session-transport`: Require transport-level `maxPayload`, RPC timeout that closes the session, pending-RPC concurrency limit, and rejection of nested `tool.call` before forward.
- `gateway-write-grants`: Keep nested unwrap for grant visibility; after unwrap, a remaining nested `tool.call` MUST NOT be treated as an authorized mutation leaf and MUST NOT be forwarded.
- `edge-engine-service`: Require session handler cleanup that always releases workspace cursor state when the session ends for any reason.

## Impact

- **Rust**: `crates/reach-rpc/src/workspace.rs` mutation path; `crates/reach-rpc/src/bin/engine.rs` session loop / cleanup; unit and integration tests for symlink races and cursor isolation.
- **TypeScript Gateway**: `packages/reach-rpc/src/gateway.ts` WebSocketServer options, nested `tool.call` reject-before-forward, timeout→session close, pending RPC cap; `gateway.test.ts` coverage.
- **Specs**: deltas under the four modified capabilities above; callers that relied on nested `tool.call` succeeding through Gateway mock Engines will now fail at the Gateway; timed-out RPCs will tear down the live session (callers must reconnect for further work).
- **Platform note**: Descriptor-relative writes remain Linux-first (as with TypeScript); unsupported platforms MUST fail closed rather than fall back to path-string check-then-write.
