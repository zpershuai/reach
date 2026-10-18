# Tasks

## 1. Protocol: ready refresh fields

- [x] 1.1 Add optional `workspaceGenerations` (`record<nonEmpty, nonEmpty>`) to `sessionReadySchema` in `packages/reach-rpc/src/index.ts`. Add the matching optional field to the Rust ready message type, then wire `session_ready` to emit it. Verify with round-trip tests in both languages that old ready messages without the field still parse.
- [x] 1.2 Document the field and the repeated-ready semantics in `docs/reference/protocol.md` using generic workspace names. Verify that the doc example matches the schema test fixture.

## 2. Gateway: refresh handling and grant revocation

- [x] 2.1 Add `GrantStore.revokeWorkspace(name, { processOnly })` in `grants.ts`. Verify with a unit test that revoked mutation and process grants fail `matches`, and that grants for other workspaces survive.
- [x] 2.2 In the `gateway.ts` ready handler, when the session is already ready: compute the removed, generation-changed and process-removed workspaces; revoke the matching grants; replace the cached metadata; call `notify()`; and emit `session.state`. Keep the `sessionId`/`engineId` mismatch path, which returns `INVALID_PARAMS` and leaves metadata unchanged. Verify with `gateway.test.ts` cases for each scenario in `specs/gateway-write-grants` and `specs/gateway-session-transport`.
- [x] 2.3 Verify in `mcp.test.ts` that `list_workspaces` and the remote `list_workspaces` return the refreshed list after a second ready, without reopening the session.
- [x] 2.4 Verify that console session events carry the updated `workspaces` and `processWorkspaces` after a refresh. Extend the existing console events or store test.

## 3. Engine: workspace model and config file parsing

- [x] 3.1 Introduce `WorkspaceSet` and `WorkspaceEntry` (canonical root, process flag, UUID generation) plus a diff function that returns `added`, `removed`, `repointed` and `process_disabled`. Verify with unit tests for each diff kind and for generation stability on unchanged entries.
- [x] 3.2 Implement JSON file parsing and validation (`deny_unknown_fields`, at least one workspace, non-empty names, absolute existing directories, canonicalization). Verify with unit tests for each invalid case in `specs/engine-workspace-config`.
- [x] 3.3 Implement source selection in `EngineConfig::parse`: `REACH_WORKSPACES_FILE`, then the environment variables, then the default `~/.reach/workspaces.json`, then the built-in default. Fail when the file and an environment variable are both set. Keep environment mode byte-for-byte compatible. Verify with `config.rs` tests that use an injected `lookup` and temporary files.
- [x] 3.4 Make `EngineConfig`, `ProcessPolicy` consumers and `run_session` ready construction read from the current `WorkspaceSet` instead of `workspace_roots` and `processes.workspaces`. In `bin/engine.rs`, keep `create_dir_all` only in environment mode. Verify that the existing `cargo test -p reach-rpc` suite passes unchanged.

## 4. Engine: applying a reload

- [x] 4.1 Add `WorkspaceFilesystem::replace_roots` and an explicit `workspace` field on `CursorSnapshot`. Drop the cursors of removed and repointed workspaces. Verify with a unit test that an affected cursor returns `INVALID_CURSOR` while an unaffected cursor continues.
- [x] 4.2 Add a `ProcessManager` operation that updates the allowlist and terminates owned processes in the given workspaces through the existing termination path. Verify with a `process_tests.rs` case: the process ends, `process.status` reports it terminated, a new `process.run` is rejected, and processes in other workspaces keep running.
- [x] 4.3 Implement the reload pipeline (validate → diff → apply). On failure, keep the last good set and emit a `WORKSPACE_RELOAD_FAILED` diagnostic without file contents. Verify with runtime tests for invalid JSON, a deleted file and a partially invalid file.

## 5. Engine: change detection and in-session refresh

- [x] 5.1 Implement `WorkspaceWatcher`: a 2-second fingerprint poll with a content-hash confirmation, using an injectable clock and stat. Verify with unit tests covering changed, unchanged and same-mtime edits.
- [x] 5.2 Extend `install_shutdown_handlers` with a SIGHUP handler that sets a reload flag (Unix only). Verify with a test that raises SIGHUP: the flag is set and the shutdown flag is not.
- [x] 5.3 Call the watcher in the idle heartbeat step and at the top of each `run_session` loop iteration. After an applied change with an observable diff, send a refreshed `session.ready` before handling the next message. Verify with `runtime.rs` tests that use the fake transport:
  - adding a workspace mid-session sends a second ready, and a following `fs.read` succeeds;
  - removing a workspace denies the next request;
  - a no-op rewrite sends nothing;
  - a reload while idle is reflected in the next session's first ready.

## 6. Documentation

- [x] 6.1 Document file mode, the JSON format, source precedence, reload triggers, last-good behaviour and the old-Gateway repoint caveat. The pages are `docs/deploy/engine.md`, `docs/deploy/configuration.md` and `docs/deploy/processes.md`, plus the `README_cn.md`/`README.md` pointers if they list workspace variables. Use only generic example paths such as `/home/example`. Verify by searching the edited docs to confirm there are no real hostnames or paths, and that every documented variable exists in `config.rs`.
- [x] 6.2 Add a migration note (environment → file) and the Gateway-first upgrade order to `docs/deploy/versions.md`. Verify that the note matches the design Migration Plan.

## 7. Integration verification

- [x] 7.1 Run `cargo test -p reach-rpc` and the `packages/reach-rpc` test script. Both must pass.
- [x] 7.2 End-to-end check with a local Gateway and an Engine in file mode:
  1. Start with workspace `default`.
  2. Add `docs` to the file and confirm MCP `list_workspaces` shows it without restarting, and that `fs.write` with a fresh grant succeeds.
  3. Repoint `docs` and confirm the old grant is rejected.
  4. Remove `docs` and confirm requests return `WORKSPACE_ACCESS_DENIED`.

  Record the results only in an ignored `.reach/` note.

## Workflow follow-up

- Archive the change after review.
- Sync the delta specs into `openspec/specs/`.
