## MODIFIED Requirements

### Requirement: Device heartbeat endpoint
The gateway SHALL accept a JSON HTTP POST at `/heartbeat` containing a `device` object from a resident Engine service. The gateway SHALL return a JSON response containing an integer `intervalSeconds` that tells the Engine when to send its next device heartbeat. The response MUST be 120 when no Agent-controlled session is open or wanted and 5 while an Agent-controlled session is wanted and no WebSocket is live. When a session is wanted and no WebSocket is live, the response MUST also contain a non-empty one-time `token`, non-empty `sessionId`, a session endpoint whose origin is the configured Gateway origin, and an absolute `leaseExpiresAt` timestamp. The token MUST expire 30 seconds after issuance. Repeated heartbeats while a token is pending MUST return the same token, session id, endpoint, and lease expiry without extending token expiry. When no session is wanted or a WebSocket is live, the response MUST NOT contain connection credentials. The heartbeat contract assumes the caller is a long-running Engine Runtime that uses the response only to acquire a session lease.

#### Scenario: Idle device heartbeat
- **WHEN** the Engine POSTs device information while no session is wanted
- **THEN** the gateway returns HTTP 200 with `intervalSeconds` set to 120 and no session connection details

#### Scenario: Agent-controlled session lease
- **WHEN** an Agent has requested a session and the Engine posts valid device information while no socket is live
- **THEN** the gateway returns `intervalSeconds` 5, a one-time token, session id, Gateway-bound endpoint, and lease expiry

#### Scenario: Live or consumed session does not mint credentials
- **WHEN** the token has been consumed or a session WebSocket is live without a new Agent open request
- **THEN** a heartbeat returns no session token

#### Scenario: Invalid heartbeat payload
- **WHEN** a client POSTs a heartbeat body that is not a JSON object containing a `device` object
- **THEN** the gateway returns HTTP 400

### Requirement: Agent session intent control
The gateway SHALL provide Agent-facing local control for opening, renewing, querying, and closing the one Engine session. It MUST record session ownership and desired state, issue or extend leases only for the active Agent-controlled session, and relay valid renew and close control messages to a ready Engine WebSocket. A close request MUST clear the wanted state and cause subsequent heartbeats to return the idle interval. A renewal MUST NOT extend a session beyond Gateway or Engine policy maxima.

#### Scenario: Agent renews a live session
- **WHEN** the active Agent renews its live session before its lease expires
- **THEN** the gateway records a new bounded expiry and sends a valid `session.renew` message to the bound Engine

#### Scenario: Agent closes a live session
- **WHEN** the active Agent requests closure of its session
- **THEN** the gateway sends `session.close`, stops accepting new session RPC after draining begins, and subsequent heartbeats return the idle interval
