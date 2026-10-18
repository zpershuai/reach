# Design

## Context

See proposal.md for the motivation. Here is the current data flow and the constraints that shape this design:

- `EngineConfig::parse` (`runtime/config.rs`) builds `workspace_roots` from `REACH_WORKSPACE_ROOTS`. `ProcessPolicy::parse` builds the execution allowlist from `REACH_PROCESS_WORKSPACES`. Both run once.
- The roots then exist twice. `WorkspaceFilesystem` (`workspace.rs`) normalizes them into a private `roots` map that has no mutator. `EngineConfig.workspace_roots` keeps a copy, and `run_session` reads that copy to build `session.ready`.
- The Runtime is a single-threaded loop. During a session, `SessionContext` holds `&mut self.workspace`, and requests are handled one at a time inside `run_session`. The `WouldBlock` branch is the idle point between messages.
- Signal handling is a static atomic flag set by a C handler (`process::install_shutdown_handlers`). It covers SIGINT and SIGTERM only.
- Gateway (`gateway.ts`) handles any `session.ready` by overwriting `session.workspaces` and `session.processWorkspaces`. The zod `sessionReadySchema` strips unknown keys. So a repeated ready message carrying an extra field is already accepted by deployed Gateways.
- `GrantStore` (`grants.ts`) keys mutation grants by `(workspace, path, methods)` with a 5-minute TTL. Grants are cleared only when an Engine is retired, not when a session closes.
- `CursorSnapshot` stores a stable query string that includes the workspace name, but the workspace is not a separate field.

## Goals / Non-Goals

**Goals:**
- Hot reload adds no new threads, locks or dependencies.
- The Engine stays the single authority on which directories are exposed.
- Deployed Gateways and environment-only Engines keep working.

**Non-Goals:**
- Remote management of workspaces through Gateway, MCP or the console.
- Hot reload of non-workspace settings: Gateway URL, tokens, timeouts, node binary, process limits.
- Watching the contents of workspace roots, or the creation or deletion of root directories after a configuration is applied.
- Hot reload when workspaces come from environment variables.
- Windows signal support. On non-Unix platforms only polling applies.

## Decisions

### D1. JSON file, one source of truth
The file format is:

```json
{
  "workspaces": {
    "default": { "path": "/home/example/.reach/workspace" },
    "scripts": { "path": "/home/example/reach-scripts", "process": true }
  }
}
```

- JSON is used because `serde_json` is already a dependency. TOML was rejected because it would add a crate, and the existing line-oriented `name:path` syntax cannot carry per-workspace flags.
- Unknown keys are rejected (`deny_unknown_fields`). This catches typos such as `proces`, which would otherwise silently disable execution.
- The per-workspace `process` flag replaces `REACH_PROCESS_WORKSPACES` for file mode. Roots and the execution allowlist are then validated together and can never drift apart.
- Source selection:
  1. `REACH_WORKSPACES_FILE` set: file mode. Also setting either workspace environment variable is an error.
  2. Otherwise, either environment variable set: environment mode, as today.
  3. Otherwise, `~/.reach/workspaces.json` exists: file mode.
  4. Otherwise: environment mode with the built-in `default` root.
- File mode does not create missing root directories. The existing `create_dir_all` of `default` stays in environment mode only, because a root that has to be auto-created in file mode is almost certainly a typo.

### D2. `WorkspaceSet` as the single runtime model
A new value type replaces the duplicated maps:

```rust
WorkspaceSet { entries: BTreeMap<name, WorkspaceEntry> }
WorkspaceEntry { root: PathBuf /* canonical */, process: bool, generation: String }
```

- `EngineConfig` carries the initial set and an optional `WorkspaceSource::File(path)`.
- `WorkspaceFilesystem` gains `replace_roots(&WorkspaceSet) -> WorkspaceDiff`.
- `run_session` builds ready metadata from the current set, not from `config`.
- `ProcessManager` reads its allowlist from the set rather than a cloned `ProcessPolicy.workspaces`.
- In file mode, roots are canonicalized at validation time. The generation then compares real directories, so a symlinked path that resolves to the same directory does not count as a repoint. Environment mode keeps today's lazy canonicalization.
- Generation tokens are random UUIDv4 values assigned when a name first appears or when its canonical root changes. A hash of the path was rejected because a fixed path guess could be checked against it, which would let a reader confirm the path behind a token.

### D3. Change detection: fingerprint polling plus SIGHUP flag
- `WorkspaceWatcher` holds the file path, the last fingerprint and the last poll time. The fingerprint is `(mtime, len, dev/inode)`, and a matching fingerprint is confirmed by comparing a content hash, which guards against same-second edits.
- The poll interval is 2 seconds.
- `install_shutdown_handlers` also installs a SIGHUP handler that sets `RELOAD_REQUESTED`.
- `watcher.check(now)` runs at two points:
  - in the idle heartbeat step, before sleeping;
  - in `run_session` at the top of each loop iteration, before reading the next message.
- The per-session check is a cheap `stat` and is skipped until the interval has elapsed or the flag is set.
- The session sleep loop is capped by `POLL_INTERVAL`, so a reload never waits longer than one poll tick.
- `notify`/FSEvents was rejected: it adds a dependency, and editors that save by atomic rename defeat naive watches. Polling every 2 seconds is negligible next to heartbeat traffic.

### D4. Apply as a diff between requests
A reload has three steps:

1. **Parse and validate** into a new `WorkspaceSet`. On error, keep the old set, emit `RuntimeEvent::Message` with `WORKSPACE_RELOAD_FAILED: <reason>` and stop.
2. **Diff** the old and new sets into `added`, `removed`, `repointed` (canonical root changed) and `process_disabled`.
3. **Apply**, inside the session if one is live:
   - Replace the roots in `WorkspaceFilesystem`.
   - Drop cursors whose workspace is in `removed ∪ repointed`. `CursorSnapshot` gains an explicit `workspace` field instead of parsing it back out of the query string.
   - Terminate owned processes in `removed ∪ repointed ∪ process_disabled` through the existing `ProcessManager` termination path, so `process.status` stays observable.
   - Update the process allowlist.
   - If any of names, generations or `processWorkspaces` changed and the session is ready, send a refreshed `session.ready` before reading the next message.

Because the loop is single-threaded, every request is executed entirely against one configuration without any locking. If no session is live, only the set is replaced. The next session's first ready message already carries the new state.

### D5. Gateway: refresh ready plus generation-based grant revocation
- `sessionReadySchema` gains `workspaceGenerations: z.record(nonEmptyString, nonEmptyString).optional()`.
- On a ready message for an already-ready session, Gateway still checks `sessionId` and `engineId`, then computes affected workspaces from the old and new metadata:
  - a name disappeared;
  - a generation changed. If either side lacks generations, a name is affected only when it disappeared;
  - a name left `processWorkspaces`, which affects process execution grants only.
- Gateway then calls `GrantStore.revokeWorkspace(name, { processOnly })`, updates the session, calls `state.notify()` and emits `session.state`.
- An explicit `workspaces_changed` message was rejected because it needs a coordinated Gateway upgrade. Reusing ready gives old Gateways list refresh for free, and only grant revocation needs the new Gateway.

## Risks / Trade-offs

- **An old Gateway does not revoke grants when a workspace is repointed.** A grant for `docs` could then authorize the new root until its 5-minute expiry. → Document "upgrade Gateway first", and advise using a new name rather than repointing on old Gateways. Engine requests for removed names are always denied, whatever the Gateway version.
- **A half-written file is read during an editor save.** → Atomic validation keeps the last good set, and the next poll picks up the completed file. Docs recommend write-then-rename.
- **A root directory deleted after it was applied** is not detected until the next reload. → Same behaviour as today: requests fail with containment or not-found errors. No new risk.
- **Repeated ready messages from a flapping file** could produce event noise. → A ready is sent only when there is an observable diff. Each reload is bounded by the poll interval.
- **`SIGHUP` now means reload.** Service managers that send SIGHUP on terminal hang-up would previously have killed the Engine. → This is intended. Documented.
- **A process killed by a reload** loses work. → Only happens when an operator explicitly removes a workspace, repoints it or disables execution. Diagnostics name the workspace.

## Migration Plan

1. Release Gateway with the ready-refresh and grant-revocation handling. This is backward compatible with current Engines, which never send a second ready.
2. Release an Engine with file mode. Existing environment-variable installs keep their current behaviour.
3. Opt-in migration for operators: write `~/.reach/workspaces.json` containing the current roots, remove `REACH_WORKSPACE_ROOTS` and `REACH_PROCESS_WORKSPACES` from the service environment, and restart once. Later workspace edits then need no restart.
4. Rollback: restore the environment variables and restart. An older Engine ignores the file.

Process control grants are scoped only to a `processId`, with no workspace identity. They remain valid until expiry; the Engine terminates affected owned processes during reload, and the grant can only control that original process.
