# Spec Delta

## MODIFIED Requirements

### Requirement: Engine startup configuration
The Engine SHALL accept one Gateway base URL (default `http://127.0.0.1:8787`), an Engine identifier, Runtime timeout policy, and workspace definitions at process start. Workspace definitions come from either an optional workspace root map override in the environment or a workspace configuration file, as defined by `engine-workspace-config`. It MUST fail fast on an invalid Gateway URL scheme, invalid timeout configuration, empty Engine identifier, invalid workspace configuration, or ambiguous workspace sources. It MUST NOT accept multiple Gateway origins in one Runtime instance.

#### Scenario: Multiple Gateway configuration is rejected
- **WHEN** Engine startup configuration supplies more than one Gateway origin
- **THEN** the Engine fails before starting heartbeat

#### Scenario: Workspace file and environment roots both supplied
- **WHEN** Engine startup configuration sets both `REACH_WORKSPACES_FILE` and `REACH_WORKSPACE_ROOTS`
- **THEN** the Engine fails before starting heartbeat

### Requirement: Engine reports process execution workspaces
The Engine SHALL include optional `processWorkspaces` in `session.ready`, listing the workspace names where local configuration currently enables process execution. An empty list SHALL report execution disabled in every workspace. Older readiness messages without this field MUST remain valid.

#### Scenario: Execution enabled for one workspace
- **WHEN** local configuration enables execution only for workspace `scripts`
- **THEN** `session.ready` contains `processWorkspaces: ["scripts"]`

#### Scenario: Execution disabled
- **WHEN** no workspace enables execution
- **THEN** the Engine sends `processWorkspaces: []` even if its supported methods include `process.run`

## ADDED Requirements

### Requirement: Engine refreshes readiness after workspace reload
When an applied workspace reload changes the set of workspace names, any generation token, or `processWorkspaces` while a session is ready, the Engine SHALL send `session.ready` again on that session. The message SHALL carry the same `sessionId`, `engineId` and `methods`, the updated `workspaces` and `processWorkspaces`, and `workspaceGenerations`. It SHALL send this before it processes any further data-plane request. A reload that changes nothing observable MUST NOT send a message.

#### Scenario: Added workspace is announced in-session
- **WHEN** workspace `docs` is added by reload while a session is ready
- **THEN** the Engine sends a `session.ready` for the same session whose `workspaces` include `docs`

#### Scenario: No-op reload is silent
- **WHEN** the file is rewritten with identical workspace definitions
- **THEN** the Engine sends no additional `session.ready`

### Requirement: Engine reports workspace generations
The Engine SHALL include optional `workspaceGenerations` in every `session.ready` it sends. The field SHALL be an object that maps each advertised workspace name to its opaque generation token, as defined by `engine-workspace-config`. Readiness messages without this field MUST remain valid.

#### Scenario: Generations accompany workspace names
- **WHEN** the Engine advertises workspaces `default` and `docs`
- **THEN** `session.ready` contains `workspaceGenerations` with exactly the keys `default` and `docs`
