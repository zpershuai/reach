# Spec Delta

## ADDED Requirements

### Requirement: Update apply is outside live session states
The Runtime MUST refuse to apply a self-update while in `Connecting`, `ActiveSession`, or `Draining`. Apply MAY run from `Heartbeating`, `Waiting`, or `Backoff` when auto-update is enabled and a verified newer artifact is staged. Successful apply MUST enter `Shutdown` and exit so the supervisor starts the replacement process. Session-scoped state MUST NOT be resumed after that exit.

#### Scenario: Apply is skipped during ActiveSession
- **WHEN** the Runtime is in `ActiveSession` and a verified newer Engine artifact is staged
- **THEN** it does not replace the binary, does not enter `Shutdown` for update, and keeps the session

#### Scenario: Idle apply exits for supervisor restart
- **WHEN** the Runtime is in `Heartbeating` with no live session and a verified newer artifact has replaced the installed binary
- **THEN** the Runtime enters `Shutdown`, the process exits, and a later process MUST obtain any session through a new heartbeat lease

### Requirement: Update check does not occupy session or heartbeat slots
A GitHub version check MUST NOT count as the Runtime's one allowed heartbeat operation or session transport. Check failure MUST apply heartbeat-style backoff for the updater only and MUST NOT change Gateway origin pinning or session non-resumption rules.

#### Scenario: Failed GitHub check still heartbeats the Gateway
- **WHEN** an enabled updater cannot reach GitHub while the Runtime is idle
- **THEN** the Runtime continues POSTing `/heartbeat` to its configured Gateway origin on the Gateway-supplied interval
