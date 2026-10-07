## ADDED Requirements

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
