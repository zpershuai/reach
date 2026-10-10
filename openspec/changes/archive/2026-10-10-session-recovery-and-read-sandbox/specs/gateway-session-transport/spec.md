## ADDED Requirements

### Requirement: Connecting session timeout
The gateway SHALL close a live Engine WebSocket that has not sent a valid `session.ready` within a connecting bound. The default bound MUST be 15 seconds and MUST be overridable for tests. After that close, the live session binding MUST be cleared so a later Agent `/session/open` is accepted. The gateway MUST still reject `/session/open` with `session already active` while a live WebSocket exists, including during the connecting window.

#### Scenario: Engine connects but never becomes ready
- **WHEN** an Engine WebSocket upgrades successfully and does not send valid `session.ready` before the connecting bound
- **THEN** the gateway closes that WebSocket and a subsequent `/session/open` succeeds

#### Scenario: Open remains rejected while connecting
- **WHEN** an Engine WebSocket is live and has not yet sent `session.ready`
- **THEN** `/session/open` returns HTTP 409 with `session already active`
