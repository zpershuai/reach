# Spec Delta

## ADDED Requirements

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
