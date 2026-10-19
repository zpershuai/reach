# edge-engine-service Specification

## Purpose

Defines the long-running Reach Engine agent that heartbeats to a Gateway, accepts issued sessions, executes workspace filesystem RPC on the Engine host, executes opt-in trusted process tasks, and follows explicit session control.

## Requirements

### Requirement: Resident Engine Runtime heartbeat loop
The Engine SHALL run as a long-lived single-Gateway Runtime that repeatedly POSTs device information to the configured Gateway `/heartbeat` endpoint while it has no active session.

#### Scenario: Required resident engine runtime heartbeat loop behavior
- **WHEN** the resident Engine receives a heartbeat reply or session message
- **THEN** It SHALL wait `intervalSeconds` from each successful idle response before the next heartbeat.
- **AND** `REACH_HEARTBEAT_INTERVAL_SECS` SHALL configure Gateway response policy; it MUST NOT be documented as an Engine-local interval override.
- **AND** Explicit session.close SHALL be the ordinary session termination path; job completion signals remain legacy compatibility only.
- **AND** When a heartbeat response includes a valid session lease, the Runtime MUST validate the endpoint against its configured Gateway origin, attempt one WebSocket connection, and enter `ActiveSession` only after session readiness is established.
- **AND** The Runtime MUST not perform ordinary heartbeat polling while a session is active and MUST return to heartbeat after every session exit.

#### Scenario: Idle polling continues
- **WHEN** the Engine receives a heartbeat response with `intervalSeconds` 120 and no session credentials
- **THEN** it waits 120 seconds and POSTs another heartbeat without opening a WebSocket

#### Scenario: Active session returns to heartbeat
- **WHEN** a ready session is explicitly closed, expires, rotates, or disconnects
- **THEN** the Runtime releases session state and resumes its configured heartbeat behavior

### Requirement: Engine-owned workspace execution
The Engine SHALL execute `fs.*` and `tool.call` filesystem methods against its own configured workspace root map. The default `default` workspace MUST map to `~/.reach/workspace` on the Engine host unless overridden at Engine startup. The Engine MUST reject unknown workspace names with `WORKSPACE_ACCESS_DENIED` and MUST apply the same containment, revision, mutation, search, and cursor rules defined by `workspace-filesystem-rpc`.

#### Scenario: Read uses the engine workspace
- **WHEN** a live session delivers a valid `fs.read` for workspace `default`
- **THEN** the Engine reads from its configured `default` root and returns the file result without requiring a Gateway-local filesystem

#### Scenario: Unknown workspace is denied on the engine
- **WHEN** a request names a workspace absent from the Engine root map
- **THEN** the Engine returns `WORKSPACE_ACCESS_DENIED` and does not touch the host filesystem outside configured roots

### Requirement: Engine session control and RPC handler role
While a session WebSocket is open, the Engine SHALL first initialize a session context and send `session.ready`.

#### Scenario: Required engine session control and rpc handler role behavior
- **WHEN** the resident Engine receives a heartbeat reply or session message
- **THEN** It SHALL accept `session.renew` and `session.close` only when they match the bound session id, apply their lease or draining effects, and accept data-plane `reach-rpc/1.0` requests only from the Gateway after readiness.
- **AND** It MUST route each valid request through the SessionDispatcher and reply with `response` or `error` that echoes `requestId`.
- **AND** It MUST NOT send filesystem `request` envelopes to the Gateway.
- **AND** On Agent close or Engine policy expiry it SHALL emit `session.closed`, clean up the session context, and close the socket.

#### Scenario: Engine handles explicit Agent close
- **WHEN** the Gateway sends a valid `session.close` for the active session
- **THEN** the Engine stops accepting new data-plane requests, drains its session work, sends `session.closed`, and closes the WebSocket

#### Scenario: Engine rejects request before readiness
- **WHEN** a data-plane request arrives before the Engine has completed session initialization
- **THEN** the Engine does not dispatch it and returns a deterministic session-not-ready error

### Requirement: Engine startup configuration
The Engine SHALL accept one Gateway base URL (default `http://127.0.0.1:8787`), an Engine identifier, Runtime timeout policy, and workspace definitions at process start. Workspace definitions come from either an optional workspace root map override in the environment or a workspace configuration file, as defined by `engine-workspace-config`.

#### Scenario: Multiple Gateway configuration is rejected
- **WHEN** Engine startup configuration supplies more than one Gateway origin
- **THEN** the Engine fails before starting heartbeat

### Requirement: Engine startup rejects invalid or ambiguous sources
The Engine MUST fail fast on an invalid Gateway URL scheme, invalid timeout configuration, empty Engine identifier, invalid workspace configuration, or ambiguous workspace sources. It MUST NOT accept multiple Gateway origins in one Runtime instance.

#### Scenario: Workspace file and environment roots both supplied
- **WHEN** Engine startup configuration sets both `REACH_WORKSPACES_FILE` and `REACH_WORKSPACE_ROOTS`
- **THEN** the Engine fails before starting heartbeat

### Requirement: Engine startup accepts optional auto-update policy
The Engine SHALL accept optional auto-update configuration at process start: enable flag, check interval, GitHub repository, optional token, and apply backend (host binary or Docker). Invalid interval, repository, or backend MUST fail fast before heartbeat. Omitted auto-update configuration MUST leave auto-update disabled and MUST remain valid for existing installations.

#### Scenario: Existing env still starts heartbeat
- **WHEN** Engine startup supplies only the current Gateway URL, Engine id, timeouts, and workspace map
- **THEN** the Engine starts heartbeat with auto-update disabled

#### Scenario: Invalid update interval fails fast
- **WHEN** auto-update is enabled with a non-positive check interval
- **THEN** the Engine exits before the first heartbeat

### Requirement: Idle heartbeat continues while an update is pending
While auto-update has recorded a newer Engine Release but the Runtime is connecting, active, or draining, the Engine MUST continue its existing heartbeat and session behavior and MUST NOT replace the binary until it returns to idle heartbeat.

#### Scenario: Pending update does not skip heartbeat
- **WHEN** a newer Engine Release is recorded during idle heartbeat and a later heartbeat returns a session lease
- **THEN** the Engine still validates the endpoint, opens one WebSocket, and enters `ActiveSession` after readiness

### Requirement: Engine reports process execution workspaces
The Engine SHALL include optional `processWorkspaces` in `session.ready`, listing the workspace names where local configuration currently enables process execution. An empty list SHALL report execution disabled in every workspace. Older readiness messages without this field MUST remain valid.

#### Scenario: Execution enabled for one workspace
- **WHEN** local configuration enables execution only for workspace `scripts`
- **THEN** `session.ready` contains `processWorkspaces: ["scripts"]`

#### Scenario: Execution disabled
- **WHEN** no workspace enables execution
- **THEN** the Engine sends `processWorkspaces: []` even if its supported methods include `process.run`

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

### Requirement: Engine reports its hardware descriptor
The resident Engine SHALL detect its device kind, model, OS, OS version and architecture once at startup and include them as `device.hardware` in every heartbeat. Detection MUST use only local system information and MUST finish or give up within 3 seconds. A failed detection MUST still send kind `unknown` and MUST NOT delay or prevent heartbeats.

#### Scenario: macOS host
- **WHEN** the Engine starts on a Mac mini
- **THEN** its heartbeats report kind `mac-mini`, the marketing model name, OS `macOS` with its version, and the CPU architecture

#### Scenario: OpenWrt router
- **WHEN** the Engine starts on a host with `/etc/openwrt_release`
- **THEN** it reports kind `router`, the board model when available, OS `OpenWrt` and the release version

#### Scenario: Raspberry Pi
- **WHEN** `/proc/device-tree/model` begins with `Raspberry Pi`
- **THEN** it reports kind `raspberry-pi` and that model string

#### Scenario: Detection fails
- **WHEN** no detection source is readable
- **THEN** the Engine reports kind `unknown` with OS and architecture from the build target and continues heartbeating normally

### Requirement: Hardware descriptor is bounded and non-identifying
The reported descriptor SHALL contain only the five defined fields. Each field MUST be truncated to 64 printable characters. Serial numbers, hostnames, MAC addresses, user names and network addresses MUST NOT be included.

#### Scenario: Long DMI product name
- **WHEN** the DMI product name is 120 characters long
- **THEN** the reported model is truncated to 64 characters

#### Scenario: Serial number available
- **WHEN** the platform exposes a hardware serial number
- **THEN** it does not appear in any heartbeat field
