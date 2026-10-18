# Proposal

## Why

Engine workspace roots come from `REACH_WORKSPACE_ROOTS` and `REACH_PROCESS_WORKSPACES`, which are parsed once at startup. `session.ready` reports them once per session, and Gateway caches that report. Adding, removing or repointing a workspace therefore needs an Engine restart. A restart drops the live session, running scripts and cursors. Operators need to change which directories are exposed without restarting the Engine, and that decision must stay local to the Engine host.

## What Changes

- Add an optional local workspace configuration file (JSON). It declares each workspace name, its absolute root and whether process execution is enabled there. The file is selected with `REACH_WORKSPACES_FILE`. If no workspace environment variables are set and the default `~/.reach/workspaces.json` exists, the Engine uses that.
- The Engine watches the file. It polls file metadata and also reloads immediately on `SIGHUP`. Each reload is validated as a whole: an invalid, unreadable, empty or missing file keeps the last good configuration and records a diagnostic.
- Workspaces can be added, removed, repointed to a new root, or have process execution switched on or off. Changes are applied between requests, never in the middle of one. Removing or repointing a workspace invalidates its query cursors and stops its owned processes. Unknown names keep returning `WORKSPACE_ACCESS_DENIED`.
- While a session is ready, the Engine sends `session.ready` again in the same session with the updated `workspaces` and `processWorkspaces` lists. It also sends a new optional `workspaceGenerations` map of opaque per-workspace identity tokens. Older Gateways already overwrite cached lists on a repeated ready message and ignore the unknown field.
- When Gateway receives a refreshed ready, it updates its session metadata, emits a session state event and revokes mutation and process execution grants for workspaces that disappeared, changed generation, or lost process execution. `list_workspaces` reflects the change without reconnecting.
- Existing environment-variable deployments behave exactly as today, with no hot reload. Setting `REACH_WORKSPACES_FILE` together with `REACH_WORKSPACE_ROOTS` or `REACH_PROCESS_WORKSPACES` is a startup error, so the source of truth is never ambiguous.

## Capabilities

### New Capabilities
- `engine-workspace-config`: Engine-local workspace configuration file, change detection, atomic validation and reload, and how added, removed and repointed workspaces affect cursors, processes and readiness reporting.

### Modified Capabilities
- `edge-engine-service`: Engine startup configuration accepts a workspace configuration file as an alternative to the environment root map. Readiness reporting of `workspaces` and `processWorkspaces` may be refreshed within a session and carries workspace generations.
- `gateway-session-transport`: Gateway accepts a repeated `session.ready` for the bound session as a metadata refresh.
- `gateway-write-grants`: Grants are revoked when their workspace is removed or repointed, or loses process execution.

## Impact

- Rust Engine (`crates/reach-rpc`):
  - `runtime/config.rs`: config source selection and file parsing.
  - `workspace.rs`: replaceable root map and cursor invalidation per workspace.
  - `runtime/runtime.rs`: reload checks in the idle and session loops, and re-sending ready.
  - `process.rs`: `SIGHUP` handler, and stopping processes in affected workspaces.
  - `bin/engine.rs`.
- TypeScript Gateway (`packages/reach-rpc`):
  - `index.ts`: the `session.ready` schema gains optional `workspaceGenerations`.
  - `gateway.ts`: handling of a repeated ready message.
  - `grants.ts`: revocation by workspace.
  - Console session events.
- Protocol: the ready schema gains an additive optional field. There is no version bump.
- Docs: `docs/deploy/engine.md`, `configuration.md`, `processes.md` and `docs/reference/protocol.md` gain the file format and reload behaviour, with generic example paths only.
- No new dependencies: JSON parsing uses the existing `serde_json`.

Process control grants are scoped only to a `processId`, with no workspace identity. They remain valid until expiry; the Engine terminates affected owned processes during reload, and the grant can only control that original process.
