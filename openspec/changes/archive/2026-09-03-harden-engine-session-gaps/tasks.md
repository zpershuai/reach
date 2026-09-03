## 1. Rust descriptor-relative mutations

- [x] 1.1 Replace path-string `atomic_write` / parent creation in `crates/reach-rpc/src/workspace.rs` with openat/`O_NOFOLLOW` (or rustix equivalent) descent, temp create, and renameat through the verified parent descriptor
- [x] 1.2 Fail closed with `WORKSPACE_ACCESS_DENIED` on platforms where no-follow descriptor-relative mutation is unavailable
- [x] 1.3 Add/extend Rust unit tests for symlink path components and parent-directory symlink replacement during write (TOCTOU)

## 2. Engine session cursor cleanup

- [x] 2.1 Add an RAII/Drop guard around `handle_session` in `crates/reach-rpc/src/bin/engine.rs` so `workspace.close()` runs on every exit path (including read/send `?` failures)
- [x] 2.2 Add a test or focused proof that cursors issued in a session are invalid after abnormal disconnect and cannot be resumed by a later session

## 3. Gateway WebSocket maxPayload

- [x] 3.1 Set `maxPayload: MAX_WEBSOCKET_TEXT_BYTES` on the Gateway `WebSocketServer` in `packages/reach-rpc/src/gateway.ts`
- [x] 3.2 Update or add a Gateway test that oversized frames are rejected at the transport layer / session closes without treating them as valid RPC

## 4. Nested tool.call alignment

- [x] 4.1 After grant unwrap in Gateway `/session/rpc`, reject nested `tool.call` (leaf still `tool.call` or empty/malformed unwrap) with `INVALID_PARAMS` and do not forward
- [x] 4.2 Update `gateway.test.ts` nested cases: keep grant-bypass rejection; change former nested-ok forward success to expect Gateway-side rejection
- [x] 4.3 Confirm Engine still rejects nested `tool.call` with `INVALID_PARAMS` (existing path or add a unit/integration assertion)

## 5. RPC timeout abort and pending concurrency

- [x] 5.1 Cap concurrent `pendingRpcs` at 16; return HTTP 503 without forwarding when the cap is exceeded
- [x] 5.2 On session RPC timeout, reject the waiter, close the live session WebSocket, and clear/fail remaining pending waiters using the same teardown path as idle/hard limits
- [x] 5.3 Add Gateway tests for pending-cap 503 and timeout→session close (including that further `/session/rpc` fails until a new session)

## 6. Verification

- [x] 6.1 Run `packages/reach-rpc` tests and `crates/reach-rpc` tests; fix regressions
- [x] 6.2 Smoke a live Gateway + Engine path for write containment, nested reject, and cursor clear if feasible in the existing roundtrip tooling

## 7. Review hardening follow-ups

- [x] 7.1 Open mutation targets with `O_NONBLOCK` so a FIFO/device is denied promptly instead of blocking the engine (add FIFO regression test)
- [x] 7.2 Retry `openat` when `mkdirat` returns `EEXIST` (concurrent parent create) instead of failing closed
- [x] 7.3 Restore a `statat(..., SYMLINK_NOFOLLOW)` final-component check immediately before `renameat`
- [x] 7.4 Create parent directories only after existence/revision checks pass, so failed mutations leave no tree changes (read path returns `Ok(None)` on a missing parent)
- [x] 7.5 Allow unix filenames containing backslash in `is_safe_component` (parity with read/stat), with a parity test
- [x] 7.6 Replace `std::os::fd` usage on the `#[cfg(not(unix))]` stubs with a crate-local `Descriptor` placeholder so non-unix builds compile while failing closed
- [x] 7.7 Retain timed-out requestIds in a bounded set that survives session teardown so a retry is rejected as a duplicate (add cross-session dedup test)
- [x] 7.8 Reject nested `tool.call` before grant matching so the response code does not depend on grant state
