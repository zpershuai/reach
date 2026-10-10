## 1. Gateway connecting timeout

- [x] 1.1 Add injectable `sessionConnectingMs` (default 15s) and close a live WebSocket that has not sent valid `session.ready` within that bound; verify a gateway test with `openEngineSession({ready:false})` and a short connecting bound closes the socket and a later `/session/open` succeeds, while open during connecting still returns 409.

## 2. MCP session recovery

- [x] 2.1 Default `readyTimeoutMs` to 150_000, add Gateway `status()`, poll through `wanted`/`pending`/`connecting`, treat `session already active` as a status poll, and best-effort close on ready timeout; verify connector tests cover timeout calling close and existing pick-once behavior.
- [x] 2.2 Confirm same-id `pick_device` only no-ops when Gateway status is `ready`, otherwise close and reopen; close the previous device when switching; verify same-id ready does not increment open count and same-id after teardown does.
- [x] 2.3 Recover reads once after dead-session errors; recover mutations only before dispatch or on explicit no-live/ready-session rejection. Return `RESULT_UNKNOWN` for uncertain dispatched mutations without replay.
- [x] 2.4 Accept `/session/close` on the stdio-proof mock Gateway and keep the list-change proof green; verify `npm --prefix packages/grok-bot-mcp-connector test` passes.

## 3. Read-path sandbox

- [x] 3.1 Route `fs.read` and `fs.stat` through `open_verified_parent` and non-blocking no-follow descriptor opens, map absence to `FILE_NOT_FOUND`, invalid UTF-8 to `NOT_UTF8`, and FIFO/device/symlink to `WORKSPACE_ACCESS_DENIED`; verify workspace tests for missing, non-UTF-8, FIFO read/stat, and symlink read, and that existing mutation FIFO/symlink tests still pass.

## 4. Verification

- [x] 4.1 Run `cargo test -p reach-rpc`, `npm --prefix packages/reach-rpc test`, and `npm --prefix packages/grok-bot-mcp-connector test`; verify all three are green.
- [x] 4.2 Document the 150s MCP ready-timeout default in the connector README if ready wait is mentioned; verify the README matches `config.ts`.

## 5. Review regressions

- [x] 5.1 Verify mutation uncertainty never replays writes/edits, while pre-dispatch failures and dead-session reads still recover.
- [x] 5.2 Verify closing-to-none recovery and a racing open rejection do not exhaust the reopen allowance.
- [x] 5.3 Verify stat rejects parent, final, and dangling symlinks while preserving regular-file and directory metadata.
- [x] 5.4 Re-run Rust and both TypeScript suites, strict OpenSpec validation, and diff whitespace checks.

Review verification: `cargo test -p reach-rpc` passed 77 tests; connector `npm test` passed 34 tests (including stdio proof); Gateway `npm test` passed 46 tests (including Rust Engine lifecycle integration). `openspec validate session-recovery-and-read-sandbox --strict` and `git diff --check` passed. No deployment was performed.
