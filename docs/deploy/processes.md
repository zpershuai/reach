# Workspace Node script tasks

English | [简体中文](processes_cn.md)

Engine offers `process.run/status/logs/stop/list` RPC for trusted `.js`, `.mjs`, `.cjs` scripts in target workspaces. HTTP MCP uses underscores, e.g. `process_run`; stdio uses dots. HTTP/static stdio require `deviceId` too.

Scripts run with the Engine service account's OS permissions. Entry/cwd validation is not a sandbox: code can access that account's files, network and system resources. No-follow descriptors snapshot entry content, loaded through the built-in Node launcher at the original module path with CJS/ESM and relative imports. Prefer `.mjs` or `package.json` `type: module` for ESM. There is no shell, arbitrary interpreter, caller Node flags/env override, stdin or npm-install interface.

## Explicitly enable execution

Set private Engine configuration on the target, for example:

```sh
REACH_PROCESS_WORKSPACES=default
REACH_PROCESS_NODE_BIN=/absolute/path/to/home/.reach/runtime/node/bin/node
```

Without an allow-list all workspaces deny execution. Default interpreter is the Engine account's `~/.reach/runtime/node/bin/node`; missing runtime returns `RUNTIME_UNAVAILABLE`, never PATH Node. `REACH_NODE_BIN` remains a separate launcher setting. Existing installations never enable execution automatically; operators update configuration/artifacts and restart by their established procedure.

| Engine setting | Default | Meaning |
| --- | --- | --- |
| `REACH_PROCESS_WORKSPACES` | Empty | Comma-separated executable workspace names |
| `REACH_PROCESS_NODE_BIN` | Private runtime entry | Absolute path |
| `REACH_PROCESS_MAX_CONCURRENT` | 4 | Concurrent tasks, max 64 |
| `REACH_PROCESS_MAX_RUNTIME_MS` | 300000 | Per-task runtime, max 86400000 |
| `REACH_PROCESS_MAX_RECORDS` | 128 | Session task records, max 1024 |
| `REACH_PROCESS_MAX_LOG_BYTES` | 1048576 | Retained bytes per task, max 16777216 |
| `REACH_PROCESS_STOP_GRACE_MS` | 2000 | Stop grace, max 10000 |

Without `timeoutMs`, use the smaller of 60000 and Engine limit; explicit values cannot exceed that limit. Records/launchIds remain until session end. Capacity exhaustion rejects new tasks without evicting deduplication records.

### Execution permissions in file mode

Engine 0.3.0 supports `REACH_WORKSPACES_FILE`, or existing `~/.reach/workspaces.json` when neither workspace environment variable exists. Per-workspace `"process": true` enables execution; default off. File mode cannot coexist with `REACH_WORKSPACE_ROOTS` or `REACH_PROCESS_WORKSPACES`. Example: `{"workspaces":{"scripts":{"path":"/home/example/reach-scripts","process":true}}}`. Roots must exist; unknown keys/invalid entries reject the whole file.

File mode polls every two seconds and accepts Unix `SIGHUP`, applying between requests. Invalid startup exits; runtime invalid/unreadable/deleted files retain last valid config and log `WORKSPACE_RELOAD_FAILED` without contents. Environment mode never hot reloads.

Removing/replacing roots or disabling execution normally terminates current-session tasks there. `process.status` retains termination records and new runs fail. Even if a process misses grace, configuration still changes; session cleanup retains ownership and retries at session end. Other workspaces continue. Removed/replaced roots invalidate file cursors too. After ready refresh, Gateway 0.7.2 revokes affected execution grants; disabling execution leaves file-write grants intact. processId-bound control grants remain until expiry.

Upgrade Gateway before Engine. Old Gateways may accept old grants for five minutes after root replacement: use new names instead. See [Engine](engine.md) and [Versions](versions.md) for sources, format and migration.

## Calling sequence

Call `list_workspaces({deviceId})` and choose a name from `processWorkspaces`. Empty means no launches. Assuming it contains `default`, create a script through file tools, then run:

```json
{
  "deviceId": "engine-a",
  "workspace": "default",
  "script": "scripts/report.mjs",
  "launchId": "report-001",
  "args": ["--format", "json"],
  "cwd": ".",
  "timeoutMs": 60000
}
```

`process_run` returns `processId`, `launchId`, state and times immediately. Optional `ifMatch` checks the entry revision, not dependencies.

- `process_status`: exactly one of `processId`/`launchId`; returns state, exit code, signal, reason and times. Running does not mean service ready.
- `process_logs`: `processId`, optional `cursor`/`maxBytes` (default/max 16384). Returns stream-tagged records, nextCursor, truncated, eof. Reuse nextCursor to avoid duplicates. Oldest bytes drop at retention limit; inability to fit the next Unicode character in maxBytes yields INVALID_PARAMS.
- `process_stop`: `processId`; normal termination followed by force after grace. Poll status after stopping. Repeated stop of completed tasks is safe.
- `process_list`: optional workspace/cursor/maxEntries (default 50, max 128); current-session tasks only.

States: starting, running, stopping, exited, stopped, timed_out, failed. Nonzero script exit is still exited; inspect exitCode. Starting is internal before spawn; successful run usually returns running but may already be terminal. Natural main-script exit also terminates ordinary same-group descendants, preventing persistent background services. Output is UTF-8 with invalid bytes replaced.

After a lost launch response, query `process_status` by original launchId in the same session. Identical launchId/arguments never launch twice; changed arguments yield `LAUNCH_ID_CONFLICT`. Same-session PROCESS_NOT_FOUND allows an explicit identical retry; MCP never retries automatically. Spawn failure returns RUNTIME_UNAVAILABLE and retains state=failed; repeating that launchId returns the same error. Use a new launchId to execute again. MCP never opens replacement sessions to observe old tasks or replays launches.

## Permissions and cleanup

MCP automatically requests execution/control grants, without human approval. Five-minute execution grants bind Engine/session/workspace/exact script/launchId; control binds processId. File-write grants cannot authorize execution. Engine independently checks workspace allow-list and task ownership.

Tasks belong to their Engine session. Close, disconnect, lease expiry, rotation and normal shutdown terminate tasks and remove output. Tasks do not renew leases; MCP observation follows existing renewal policy. Active tasks delay idle close but cannot exceed lease/rotation. Tasks/logs cannot be restored across sessions. Failed cleanup retains ownership/retries; SIGTERM during failure logs PROCESS_CLEANUP_FAILED and exits without claiming release. Kernel-uninterruptible processes may survive exit.

Unix manages independent process groups, terminates ordinary descendants and reaps direct children; parents/OS reap grandchildren. Descendants deliberately escaping groups and OS-forced Engine termination fall outside normal guarantees. Non-Unix registers no process methods; MCP treats the feature as unsupported and internal execution returns `PROCESS_UNSUPPORTED`.

Before deployment, run equivalent module-loading, child-stop and session-cleanup integration checks with the installed private runtime on the target platform. Cross-compilation alone does not verify target execution.
