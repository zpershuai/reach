## Context

Model B moved filesystem execution into the Rust Engine while the TypeScript Gateway retained grants, session transport, and `/session/rpc` proxying. The TypeScript workspace already used Linux descriptor-relative (`/proc/self/fd`, `O_NOFOLLOW`) mutations from the harden-gateway change. The Rust port reintroduced path-string check-then-rename writes. Several Gateway limits (`maxPayload`, pending RPC concurrency, timeout abort) and Engine session teardown (cursor `close()`) are incomplete or inconsistent with nested `tool.call` handling.

Decided with the change author:

- Nested `tool.call`: Gateway rejects before forward (still unwraps for grant visibility); Engine keeps rejecting nesting.
- RPC timeout: close the live session WebSocket to abort in-flight Engine work; cap pending RPCs at 16.

## Goals / Non-Goals

**Goals:**

- Close the Rust mutation TOCTOU gap to the same containment class as TypeScript descriptor-relative writes.
- Enforce the 1 MiB WebSocket limit before full application buffering.
- Guarantee session-scoped cursor cleanup on all Engine session exit paths.
- Align Gateway and Engine nested `tool.call` rejection, with Gateway failing closed before forward.
- Bound pending `/session/rpc` concurrency and abort Engine work on RPC timeout by tearing down the session.

**Non-Goals:**

- A new cancel/abort RPC method or cooperative mid-write cancellation protocol.
- Cross-platform descriptor-relative writes beyond what the TypeScript path already supports (Linux-first; fail closed elsewhere).
- Changing grant issuance, heartbeat intervals, or the public filesystem method surface (aside from rejecting nested `tool.call`).
- Persisting cursors or pending RPCs across process restarts.

## Decisions

### Restore descriptor-relative mutations in Rust

Reimplement `atomic_write` (and parent creation used by writes/edits) with `openat`-style descent: open the real root with `O_DIRECTORY | O_NOFOLLOW`, walk each component with no-follow directory opens, create missing parents through the current parent fd, create the temp file with `O_CREAT | O_EXCL | O_NOFOLLOW` in the parent fd, then `renameat` onto the final name in that parent. Prefer `rustix` (already in the dependency graph via the workspace) or equivalent libc wrappers.

**Review follow-ups applied to this decision:**
- The mutation read opens the target with `O_NONBLOCK` so a FIFO/device at the target is denied promptly instead of stalling the single-threaded engine (which holds `write_lock` during writes).
- A `mkdirat` that races a concurrent parent create (`EEXIST`) is handled by re-opening the component with `NOFOLLOW`, not by failing closed with a spurious denial.
- The final-component symlink check that the old path-string code ran immediately before rename is restored (via `statat(..., SYMLINK_NOFOLLOW)`) so a symlink swapped in after the pre-read is denied, not silently replaced.
- Missing parents are created only after the write/edit existence-and-revision checks pass: the read path returns "not found" on a missing parent (`Ok(None)`), so a failed mutation never leaves directory skeletons behind.
- `is_safe_component` allows backslash in unix filenames (a legal byte, not a separator), restoring parity with the read/stat/glob path.
- The `#[cfg(not(unix))]` fail-closed stubs use a crate-local `Descriptor` placeholder type so they compile on platforms where `std::os::fd` is unavailable.

**Alternatives considered:** Keep path-string checks and add a post-rename `canonicalize` audit — rejected; it does not prevent the write escaping. Port only on Linux and soft-fail elsewhere — accepted as fail-closed, matching TypeScript.

### Set `maxPayload` on the Gateway WebSocketServer

Configure `new WebSocketServer({ noServer: true, maxPayload: MAX_WEBSOCKET_TEXT_BYTES })`. Keep the existing application-level size check as defense in depth for assembled messages, but rely on `maxPayload` to stop oversized frame buffering.

### RAII cursor cleanup in the Engine session handler

Introduce a small guard (e.g. `struct SessionWorkspace<'a>(&'a mut WorkspaceFilesystem)` with `Drop` calling `close()`), or an explicit `defer`-style scope guard around `handle_session`, so every early `?` return clears cursors. Prefer Drop over duplicating `workspace.close()` at each exit site.

### Reject nested `tool.call` at Gateway before grant matching

Reuse `isNestedToolCall` against the original method, and reject before any grant lookup: if the method is `tool.call` and unwrapping yields another `tool.call` (or an empty method from malformed/pathological nesting), return `INVALID_PARAMS` without forward. Rejecting before grant matching keeps the response code independent of grant state (no `PERMISSION_DENIED`-vs-`INVALID_PARAMS` oracle). Single-level `tool.call` → `fs.*` remains allowed and is still unwrapped via `effectiveMethod` for grant discovery. Engine keeps its existing nested reject as a second line of defense.

Update Gateway tests that currently expect nested-ok forward success against a mock Engine to expect Gateway-side rejection instead; add an integration-style test that would have caught Engine/Gateway disagreement.

### Timeout closes the session; pending cap is 16

On RPC timer fire: delete the pending entry, reject the waiter, call the same session teardown used for idle/hard limits (close WebSocket, clear pending map, clear live session state). Do not invent a cancel envelope. Before accepting a new forward, if `pendingRpcs.size >= 16`, return HTTP 503. Because the teardown it triggers clears the in-session `seenRequestIds`, the timed-out `requestId` is additionally retained in a bounded set (`timedOutRequestIds`, FIFO-evicted) that survives session close, so retrying the same `requestId` in a later session is rejected as a duplicate rather than re-executed.

**Alternatives considered:** Best-effort abandon without closing the socket — rejected because timed-out mutations can still land. Dedicated cancel protocol — deferred as larger surface area.

## Risks / Trade-offs

- [Closing the session on one timed-out RPC aborts unrelated in-flight RPCs] → Acceptable; session is single-tenant and timeout already indicates an unhealthy Engine. Document that callers must re-establish a session after timeout.
- [Descriptor APIs are Linux-centric] → Fail closed on unsupported platforms; unit tests for symlink replacement run where `O_NOFOLLOW`/`openat` are available.
- [Nested `tool.call` callers that previously passed Gateway mock tests will break] → Intended **BREAKING** for that niche; single-level `tool.call` remains supported.
- [Engine may finish a mutation after the Gateway decides to close but before the TCP close is observed] → Residual race; closing the socket is best-effort abort without a cancel protocol. Prefer short RPC timeouts and the pending cap to limit exposure. The Gateway now refuses a retry of the same timed-out `requestId` across session reconnects (bounded retention), so a same-id retry cannot re-apply the mutation; a retry under a fresh `requestId` still re-runs the operation.
- [RAII Drop during panic vs Result early-return] → Cover Result paths first; panic unwind also runs Drop, which is desirable for cursor clear.

## Migration Plan

1. Land Rust descriptor-relative writes and Engine session Drop guard with unit tests.
2. Update Gateway `maxPayload`, nested reject, pending cap, and timeout→close behavior with focused tests.
3. Adjust any Gateway tests that asserted nested forward success.
4. Run package and crate tests; optionally exercise a live Gateway+Engine roundtrip for timeout and cursor isolation.
5. Rollback by reverting the change; no persisted state migration required.

## Open Questions

- None blocking implementation; platform fail-closed behavior follows the existing TypeScript precedent.
