## 1. Gateway session as request driver

- [x] 1.1 Remove Gateway WebSocket filesystem dispatch against Gateway-local `WorkspaceFilesystem` so live sessions no longer serve Engine-originated `fs.*` against the Gateway host.
- [x] 1.2 Add live-session request forwarding helpers on the Gateway (send complete `reach-rpc/1.0` envelopes, wait for matching `response`/`error`, enforce session bounds/idle rules).
- [x] 1.3 Implement local `POST /session/rpc` that requires a live Engine session, binds `sessionId`, validates write grants before forwarding mutations, and returns the Engine reply (409/503 when no session).
- [x] 1.4 Add a Gateway-triggered completion path that causes the Engine to emit `job.done` (for example RPC `session.complete` or an explicit finish control message) and verify the Gateway closes the socket and returns idle heartbeats.

## 2. Resident Engine service

- [x] 2.1 Replace the one-shot `session-client` flow with a long-running Engine binary that loops on `/heartbeat`, sleeps `intervalSeconds`, and connects when `wssUrl`/`token`/`sessionId` are present.
- [x] 2.2 Accept Gateway base URL and optional workspace root map overrides at Engine startup (default `http://127.0.0.1:8787` and `default → ~/.reach/workspace`).
- [x] 2.3 On an open session, accept Gateway-originated request envelopes, reject mismatched `sessionId`/malformed envelopes with `INVALID_PARAMS`, and never send filesystem `type=request` messages to the Gateway.

## 3. Engine workspace filesystem

- [x] 3.1 Implement Engine-side workspace roots, containment, revisions, and `fs.read` / `fs.list` / `fs.stat` in Rust aligned with existing DTOs and fixture expectations.
- [x] 3.2 Implement `fs.write` / `fs.edit` on the Engine with atomic replacement semantics; require `permission.grantId` and only execute mutations received via the Gateway-forwarded session path.
- [x] 3.3 Implement `fs.glob` / `fs.grep`, session-scoped cursors, and `tool.call` dispatch on the Engine with the same bounds as `workspace-filesystem-rpc`.
- [x] 3.4 Stop using TypeScript `WorkspaceFilesystem` on the Gateway session path; keep or delete the TS module only as needed for leftover unit tests.

## 4. Proofs, tests, and docs

- [x] 4.1 Rewrite Gateway/Engine integration tests for Model B: start Gateway + Engine, `session-wanted`, heartbeat-issued connect, `/session/rpc` read/write through grants, then `job.done`/close.
- [x] 4.2 Update README with the two-process loopback proof (Gateway, Engine service, curl control plane) and document that files live under the Engine workspace.
- [x] 4.3 Run `npm test` and `cargo test` (plus any documented manual curl proof) and fix regressions from the RPC direction change.
