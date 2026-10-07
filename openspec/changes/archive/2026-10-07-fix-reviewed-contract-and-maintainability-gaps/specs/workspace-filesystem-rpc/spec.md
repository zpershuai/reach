## MODIFIED Requirements

### Requirement: Session-scoped query cursors and operation sizes
The system SHALL bind pagination cursors to the active session, method, and complete query. It MUST reject cursors after disconnect or when reused for another method or query, and it MUST allow no more than 32 live cursors per session. Each read, write, and edit operation MUST reject a file larger than 8 MiB with `FILE_TOO_LARGE`. Each filesystem method SHALL be invokable directly and through a single-level `tool.call` using `{ name, arguments }` where `name` is a supported filesystem method. Nested `tool.call` (a `tool.call` whose `name` is itself `tool.call`) MUST be rejected with `INVALID_PARAMS` and MUST NOT dispatch a filesystem operation. When a session ends for any reason, including abnormal disconnect or send failure, the system MUST clear all cursors belonging to that session so a later session cannot resume them.

#### Scenario: Reject an excess cursor
- **WHEN** a session attempts to create a 33rd live filesystem cursor
- **THEN** the operation fails without creating that cursor

#### Scenario: Reject an oversized file operation
- **WHEN** a read, write, or edit addresses a file exceeding 8 MiB
- **THEN** the operation returns `FILE_TOO_LARGE` without returning or changing its content

#### Scenario: Reject a cursor reused for another query
- **WHEN** a cursor issued for one filesystem query is used with changed query parameters or another method
- **THEN** the system rejects the cursor as invalid

#### Scenario: Dispatch a filesystem tool call
- **WHEN** a caller invokes `tool.call` with a filesystem method name and its arguments
- **THEN** the system returns the same operation result as direct invocation

#### Scenario: Reject nested tool.call
- **WHEN** a caller invokes `tool.call` whose `name` is `tool.call`
- **THEN** the system returns `INVALID_PARAMS` and does not dispatch a nested filesystem operation

#### Scenario: Clear cursors after abnormal session end
- **WHEN** a session ends because the WebSocket read or response send fails before a clean `session.close` close
- **THEN** all cursors created during that session are invalidated and a later session cannot resume them
