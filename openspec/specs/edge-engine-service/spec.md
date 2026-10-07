# edge-engine-service Specification

## Purpose

Defines the long-running Reach Engine agent that heartbeats to a Gateway, accepts issued sessions, executes workspace filesystem RPC on the Engine host, executes opt-in trusted process tasks, and follows explicit session control.

## Requirements

### Requirement: Resident Engine Runtime heartbeat loop
The Engine SHALL run as a long-lived single-Gateway Runtime that repeatedly POSTs device information to the configured Gateway `/heartbeat` endpoint while it has no active session. It SHALL wait `intervalSeconds` from each successful idle response before the next heartbeat. `REACH_HEARTBEAT_INTERVAL_SECS` SHALL configure Gateway response policy; it MUST NOT be documented as an Engine-local interval override. Explicit session.close SHALL be the ordinary session termination path; job completion signals remain legacy compatibility only. When a heartbeat response includes a valid session lease, the Runtime MUST validate the endpoint against its configured Gateway origin, attempt one WebSocket connection, and enter `ActiveSession` only after session readiness is established. The Runtime MUST not perform ordinary heartbeat polling while a session is active and MUST return to heartbeat after every session exit.

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
While a session WebSocket is open, the Engine SHALL first initialize a session context and send `session.ready`. It SHALL accept `session.renew` and `session.close` only when they match the bound session id, apply their lease or draining effects, and accept data-plane `reach-rpc/1.0` requests only from the Gateway after readiness. It MUST route each valid request through the SessionDispatcher and reply with `response` or `error` that echoes `requestId`. It MUST NOT send filesystem `request` envelopes to the Gateway. On Agent close or Engine policy expiry it SHALL emit `session.closed`, clean up the session context, and close the socket.

#### Scenario: Engine handles explicit Agent close
- **WHEN** the Gateway sends a valid `session.close` for the active session
- **THEN** the Engine stops accepting new data-plane requests, drains its session work, sends `session.closed`, and closes the WebSocket

#### Scenario: Engine rejects request before readiness
- **WHEN** a data-plane request arrives before the Engine has completed session initialization
- **THEN** the Engine does not dispatch it and returns a deterministic session-not-ready error

### Requirement: Engine startup configuration
The Engine SHALL accept one Gateway base URL (default `http://127.0.0.1:8787`), an Engine identifier, Runtime timeout policy, and optional workspace root map overrides at process start. It MUST fail fast on an invalid Gateway URL scheme, invalid timeout configuration, or empty Engine identifier. It MUST NOT accept multiple Gateway origins in one Runtime instance.

#### Scenario: Multiple Gateway configuration is rejected
- **WHEN** Engine startup configuration supplies more than one Gateway origin
- **THEN** the Engine fails before starting heartbeat
