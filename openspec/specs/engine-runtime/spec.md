# engine-runtime Specification

## Purpose

Defines the resident Engine lifecycle, bounded leases, session cleanup, and local Gateway transport policy.

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

Running a Tool MUST count as activity even when the configured idle timeout is shorter than its RPC execution bound. The idle window MUST restart after the worker drains. Lease expiry, rotation, and the hard execution bound MUST remain enforceable during active work.

#### Scenario: A Tool executes longer than the idle interval
- **WHEN** a Tool runs beyond the idle interval while within its lease, rotation, and execution bounds
- **THEN** the Runtime does not close it for inactivity and starts a fresh idle window when the worker finishes

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

### Requirement: Initial lease and local transport bounds
The Engine MUST cap both initial and renewed lease expiry at the current time plus its configured lease ceiling. Its current plaintext transport MUST accept only HTTP loopback IP literals or localhost, and resolved socket addresses MUST all be loopback addresses.

#### Scenario: Gateway supplies an excessive initial lease
- **WHEN** an initial lease exceeds the Engine lease ceiling
- **THEN** the Engine closes at its own ceiling even if the Gateway remains connected

#### Scenario: Reject a non-local plaintext Gateway
- **WHEN** startup specifies a non-loopback host or resolution yields a non-loopback address
- **THEN** the Engine rejects the configuration or transport attempt without connecting

### Requirement: Bounded consumable lifecycle events
The Runtime MUST retain at most 1,024 lifecycle events, evicting the oldest on overflow. Its drain API MUST consume events. The production outer loop MUST consume events when reporting lifecycle messages and structured JSON events.

#### Scenario: Consume events after a long-running session
- **WHEN** the Runtime emits more than its event buffer capacity and the consumer drains it
- **THEN** memory remains bounded and a second drain returns no previously consumed events

### Requirement: Session-owned background process cleanup
The Runtime SHALL own managed process state through the active SessionContext. Close, disconnect, lease expiry, rotation, shutdown and session failure MUST reject new launches, terminate and reap owned processes, close collectors and release records before heartbeat resumes or a replacement session opens. Cleanup MUST use bounded graceful and forced termination; unresolved cleanup failures MUST be reported and MUST NOT be represented as successful draining. Tasks, logs, launch identities and permissions MUST NOT resume in a later session. Abrupt OS termination of Engine is outside graceful-cleanup guarantees.

#### Scenario: Disconnect with background tasks
- **WHEN** transport disconnects while scripts are active
- **THEN** Runtime terminates and reaps those tasks before releasing the session and returning to heartbeat

#### Scenario: Rotation while script runs
- **WHEN** the continuous session age reaches its local ceiling during background execution
- **THEN** rotation still drains owned tasks and no task is adopted by the next session

### Requirement: Background activity preserves hard lifecycle bounds
Live managed tasks SHALL count as activity for idle detection, and completion SHALL restart the idle window. Background tasks MUST NOT extend the lease or rotation ceiling. MCP observation calls SHALL continue using existing renewal policy; tasks MUST NOT renew themselves.

#### Scenario: Task runs through idle interval
- **WHEN** a task remains active beyond the idle interval while lease and rotation are valid
- **THEN** idle closure does not interrupt it, but lease expiry still terminates and drains it

### Requirement: Engine-local execution configuration
Engine SHALL accept validated operator configuration for execution-enabled workspaces, absolute private runtime path, concurrency, runtime ceiling, retained task records, output retention and stop grace period. The default workspace execution allowlist SHALL be empty. Gateway requests MUST NOT relax this policy. Existing installation configuration MUST remain valid without enabling execution.

#### Scenario: Existing installation upgrades
- **WHEN** an existing filesystem-only configuration is used with the upgraded Engine
- **THEN** filesystem access remains configured as before and process execution remains disabled

#### Scenario: Shutdown during unresolved process cleanup
- **WHEN** cleanup has failed and SIGTERM requests Engine shutdown
- **THEN** Engine reports PROCESS_CLEANUP_FAILED and exits after bounded cleanup attempts, without reporting successful session release, resuming heartbeat or opening a replacement session
