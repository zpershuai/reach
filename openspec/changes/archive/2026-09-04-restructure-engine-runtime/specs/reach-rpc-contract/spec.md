## ADDED Requirements

### Requirement: Session control message contract
The system SHALL represent Engine session control separately from data-plane request envelopes. Supported control message types are `session.ready`, `session.renew`, `session.close`, and `session.closed`; each MUST contain a non-empty `sessionId`. `session.renew` MUST include a valid absolute `leaseExpiresAt` timestamp. `session.close` and `session.closed` MUST include a non-empty machine-readable reason. Unknown or malformed control fields MUST be rejected as `INVALID_PARAMS` without dispatching a Tool.

#### Scenario: Reject malformed session renewal
- **WHEN** an Engine receives `session.renew` without a valid session id or absolute expiry timestamp
- **THEN** it rejects the message as `INVALID_PARAMS` and does not extend the lease

### Requirement: Engine readiness capability advertisement
The system SHALL represent Engine readiness as a `session.ready` control message containing the protocol name/version, a non-empty Engine identifier, the bound session id, supported canonical method names, and configured workspace names. The Gateway MUST wait for a valid ready message before forwarding data-plane RPC for that session.

#### Scenario: Gateway waits for Engine readiness
- **WHEN** a WebSocket has upgraded successfully but the Engine has not sent a valid `session.ready`
- **THEN** the Gateway does not forward an Agent RPC onto that session
