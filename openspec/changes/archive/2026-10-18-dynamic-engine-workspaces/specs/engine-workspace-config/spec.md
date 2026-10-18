# Spec Delta

## Purpose

Lets an Engine operator add, remove and repoint workspaces through a local configuration file that the running Engine reloads. Workspace exposure stays a host-local decision and does not need an Engine restart.

## ADDED Requirements

### Requirement: Workspace configuration file source
The Engine SHALL read workspace definitions from a local JSON file when `REACH_WORKSPACES_FILE` names one. When no workspace environment variables are set and `~/.reach/workspaces.json` exists, the Engine SHALL use that file. Each entry SHALL map a workspace name to an absolute root path and an optional boolean that enables process execution, which defaults to false.

#### Scenario: Explicit file supplies workspaces
- **WHEN** `REACH_WORKSPACES_FILE` names a valid file declaring workspaces `default` and `scripts`, with execution enabled only for `scripts`
- **THEN** the Engine serves both workspaces and reports `processWorkspaces: ["scripts"]`

#### Scenario: Default file is discovered
- **WHEN** none of `REACH_WORKSPACES_FILE`, `REACH_WORKSPACE_ROOTS` or `REACH_PROCESS_WORKSPACES` is set and `~/.reach/workspaces.json` exists
- **THEN** the Engine loads workspaces from that file and watches it for changes

#### Scenario: Environment-only deployment is unchanged
- **WHEN** `REACH_WORKSPACE_ROOTS` is set and `REACH_WORKSPACES_FILE` is not
- **THEN** the Engine uses the environment root map exactly as before and does not reload workspaces at runtime

#### Scenario: Ambiguous sources are rejected
- **WHEN** `REACH_WORKSPACES_FILE` is set together with `REACH_WORKSPACE_ROOTS` or `REACH_PROCESS_WORKSPACES`
- **THEN** the Engine fails at startup before heartbeating

### Requirement: Workspace configuration validation
The Engine SHALL treat a workspace configuration as valid only when it parses as the documented JSON shape and declares at least one workspace. Every name must be non-empty, and every root must be an absolute path to an existing directory. At startup an invalid file SHALL fail the Engine before heartbeating. A configuration file MUST NOT be able to contain secrets or Gateway settings.

#### Scenario: Invalid file at startup
- **WHEN** the configured file contains a relative root path at startup
- **THEN** the Engine reports a configuration error and exits before heartbeating

#### Scenario: Missing root directory
- **WHEN** a workspace entry names a root that does not exist or is not a directory
- **THEN** the configuration is invalid

### Requirement: Runtime workspace change detection
While running with a workspace configuration file, the Engine SHALL detect changes to that file by polling it at a bounded interval of at most 5 seconds. It SHALL also reload promptly after receiving `SIGHUP`. It SHALL check for changes both while idle-heartbeating and between requests of a live session. A `SIGHUP` MUST NOT terminate the Engine.

#### Scenario: Edited file is picked up without restart
- **WHEN** the operator adds workspace `docs` to the file while the Engine is running
- **THEN** within the polling interval, `fs.*` requests for `docs` succeed without restarting the Engine

#### Scenario: SIGHUP forces reload
- **WHEN** the operator edits the file and sends `SIGHUP` to the Engine
- **THEN** the Engine reloads the file at its next loop point without waiting for the polling interval, and keeps running

### Requirement: Atomic reload with last-good fallback
The Engine SHALL apply a reloaded configuration as a whole or not at all. When a reloaded file is unreadable, missing, unparsable or invalid, the Engine SHALL keep serving the last valid configuration. It SHALL emit a diagnostic that names the failure without echoing file contents, and it MUST NOT exit or close the session.

#### Scenario: Broken edit keeps old workspaces
- **WHEN** a running Engine's file is rewritten with invalid JSON
- **THEN** the previously configured workspaces remain available, a reload-failure diagnostic is emitted, and the live session stays open

#### Scenario: Deleted file keeps old workspaces
- **WHEN** the configuration file is deleted while the Engine runs
- **THEN** the Engine keeps the last valid workspaces instead of removing all of them

#### Scenario: Partially invalid file changes nothing
- **WHEN** a reload adds valid workspace `a` and an entry `b` whose root does not exist
- **THEN** neither change is applied

### Requirement: Reload applies between requests
The Engine SHALL apply a configuration change only between data-plane requests. A request that is already executing SHALL complete against the configuration it started with. Every request received after the change is applied SHALL use the new configuration, and requests for workspaces no longer present SHALL return `WORKSPACE_ACCESS_DENIED`.

#### Scenario: Removed workspace is denied
- **WHEN** workspace `docs` is removed from the file and the reload is applied
- **THEN** a subsequent `fs.read` for `docs` returns `WORKSPACE_ACCESS_DENIED` and touches no file

#### Scenario: Repointed workspace uses the new root
- **WHEN** workspace `docs` is changed to a different root directory and the reload is applied
- **THEN** subsequent requests for `docs` resolve paths only under the new root

### Requirement: Workspace generation identity
The Engine SHALL assign each workspace an opaque generation token. The token SHALL stay the same across reloads while the workspace's canonical root is unchanged. It SHALL change when the workspace is repointed, and when a workspace is removed and later added again. Tokens MUST NOT reveal the root path.

#### Scenario: Unchanged workspace keeps its generation
- **WHEN** a reload adds workspace `docs` and leaves `default` unchanged
- **THEN** `default` reports the same generation token as before the reload

#### Scenario: Repoint changes generation
- **WHEN** a reload changes the root of `docs`
- **THEN** `docs` reports a new generation token

### Requirement: Affected workspace state is invalidated
When a reload removes or repoints a workspace, the Engine SHALL stop honouring query cursors issued for that workspace, which then return `INVALID_CURSOR`, and SHALL terminate owned processes running in it. When a reload disables process execution for a workspace, the Engine SHALL terminate the owned processes running there and reject new launches in it. Cursors and processes of unaffected workspaces MUST be preserved.

#### Scenario: Cursor of removed workspace is invalid
- **WHEN** a client holds a `fs.glob` cursor for `docs` and `docs` is removed by reload
- **THEN** continuing with that cursor returns `INVALID_CURSOR`

#### Scenario: Process stopped when execution is disabled
- **WHEN** an owned process runs in `scripts` and a reload disables execution for `scripts`
- **THEN** the Engine terminates that process using the normal termination path, `process.status` reports it as terminated, and new `process.run` requests for `scripts` are rejected

#### Scenario: Unaffected workspace keeps its state
- **WHEN** a reload adds workspace `docs` while a cursor and a process are active in `default`
- **THEN** the `default` cursor and process continue unaffected
