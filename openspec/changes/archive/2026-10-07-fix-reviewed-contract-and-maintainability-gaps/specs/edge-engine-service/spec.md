## MODIFIED Requirements

### Requirement: Resident Engine Runtime heartbeat loop
The Engine SHALL run as a long-lived single-Gateway Runtime that repeatedly POSTs device information to the configured Gateway `/heartbeat` endpoint while it has no active session. It SHALL wait `intervalSeconds` from each successful idle response before the next heartbeat. `REACH_HEARTBEAT_INTERVAL_SECS` SHALL configure Gateway response policy; it MUST NOT be documented as an Engine-local interval override. Explicit session.close SHALL be the ordinary session termination path; job completion signals remain legacy compatibility only. When a heartbeat response includes a valid session lease, the Runtime MUST validate the endpoint against its configured Gateway origin, attempt one WebSocket connection, and enter `ActiveSession` only after session readiness is established. The Runtime MUST not perform ordinary heartbeat polling while a session is active and MUST return to heartbeat after every session exit.

#### Scenario: Idle polling continues
- **WHEN** the Engine receives a heartbeat response with `intervalSeconds` 120 and no session credentials
- **THEN** it waits 120 seconds and POSTs another heartbeat without opening a WebSocket

#### Scenario: Active session returns to heartbeat
- **WHEN** a ready session is explicitly closed, expires, rotates, or disconnects
- **THEN** the Runtime releases session state and resumes its configured heartbeat behavior
