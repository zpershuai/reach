## MODIFIED Requirements

### Requirement: Session-scoped query cursors and tool dispatch
The system SHALL bind pagination cursors to the active Engine session, canonical filesystem method, and complete query. It MUST reject cursors after session disconnect, expiry, drain, or when reused for another method or query. Each filesystem method SHALL be invokable directly through its registered canonical method. A single-level `tool.call` wrapper MAY be accepted only as a compatibility adapter and MUST be canonicalized before authorization and Tool dispatch; nested or malformed `tool.call` MUST be rejected as `INVALID_PARAMS`.

#### Scenario: Reject a cursor reused for another query
- **WHEN** a cursor issued for one filesystem query is used with changed query parameters or another method
- **THEN** the system rejects the cursor as invalid

#### Scenario: Cursor is invalid after session policy closure
- **WHEN** a session ends because of lease expiry, idle timeout, rotation, or transport disconnect
- **THEN** a later session cannot use its cursor

#### Scenario: Dispatch a filesystem tool call
- **WHEN** a caller invokes one valid `tool.call` wrapper with a filesystem method name and its arguments
- **THEN** the system returns the same operation result as direct canonical invocation

### Requirement: Filesystem operation cancellation boundary
The system SHALL associate every filesystem operation with the active SessionContext cancellation and deadline policy. A Tool MUST NOT begin a queued filesystem operation after its session enters draining or its request deadline has elapsed. An operation that has already reached an atomic workspace mutation boundary MAY complete before transport closure, but its result MUST NOT be retained for a later session.

#### Scenario: Queued mutation is cancelled on session close
- **WHEN** a write is queued behind another request and the active session enters draining before the write starts
- **THEN** the queued write is not performed and the caller receives a session-closing or deadline error
