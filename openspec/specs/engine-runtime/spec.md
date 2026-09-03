# engine-runtime Specification

## Purpose

TBD: Define the runtime lifecycle contract. Update Purpose after archive.

## Requirements

### Requirement: Single-Gateway Engine Runtime lifecycle
The Engine SHALL run one resident Runtime bound to exactly one configured Gateway origin. The Runtime SHALL model `Boot`, `Heartbeating`, `Waiting`, `Connecting`, `ActiveSession`, `Draining`, `Backoff`, and `Shutdown` states. It MUST have no more than one active session transport, one connection attempt, and one heartbeat operation at a time. It MUST resume heartbeat only after the prior session has completed draining and its session resources have been released.

#### Scenario: WebSocket disconnect returns to heartbeat
- **WHEN** the active session WebSocket closes without an explicit Engine shutdown
- **THEN** the Runtime drains the session, releases its resources, and resumes heartbeat through `Backoff` when the close is an error

### Requirement: Renewable Engine session lease
The Runtime SHALL keep an active session only while it has a valid lease from its configured Gateway. A lease MUST have an absolute expiry and MAY be extended only by a valid Gateway session-renew control message. The Runtime MUST close and drain the session when the lease expires, even if the transport remains connected.

#### Scenario: Abandoned Agent lease expires
- **WHEN** the Agent stops renewing a live session and the lease expiry passes
- **THEN** the Engine rejects new RPC, drains the session, emits a lease-expired closure reason, and returns to heartbeat

### Requirement: Runtime safety limits
The Runtime SHALL enforce bounded connection setup, RPC execution, session inactivity, and continuous connection age. The Engine MUST treat configured values as upper bounds and MUST NOT accept an Agent or Gateway request that relaxes its hard maximum. The initial defaults SHALL be 15 seconds for connection setup, five minutes for idle and lease duration, 30 seconds for an unspecified RPC deadline, and eight hours for continuous session rotation.

#### Scenario: Continuous session reaches rotation limit
- **WHEN** an otherwise healthy session reaches the configured continuous connection age limit
- **THEN** the Engine enters draining, reports a rotation closure reason, closes the transport, and obtains any replacement session through a new heartbeat lease

### Requirement: Session-scoped cleanup and non-resumption
The Runtime SHALL create a `SessionContext` only on entry to `ActiveSession`. The context MUST own request identity state, cancellation, cursor scope, authorization context, queue state, and lifecycle telemetry. On every exit from an active session, including failure paths, the Engine MUST clear the context and MUST NOT resume its cursors, pending requests, permissions, or in-flight work in a later session.

#### Scenario: Reconnect cannot reuse prior session state
- **WHEN** a session disconnects while it has a live cursor or queued request and a later heartbeat establishes a new session
- **THEN** the new session cannot resume that cursor or execute the prior queued request

### Requirement: Gateway endpoint pinning
The Runtime SHALL connect only to the configured Gateway origin. A session endpoint supplied during heartbeat MUST be a relative endpoint resolved against that origin or an absolute endpoint with the same normalized origin. The Engine MUST reject a lease endpoint that points elsewhere.

#### Scenario: Heartbeat attempts endpoint redirection
- **WHEN** a heartbeat lease supplies a WebSocket endpoint with a different origin from the configured Gateway
- **THEN** the Engine rejects the lease, does not open a connection to that endpoint, and applies its heartbeat failure/backoff policy
