## Purpose

Defines the local gateway heartbeat loop that lets the engine report device information and receive its next polling interval, plus optional one-time session connection details.

## Requirements

### Requirement: Device heartbeat endpoint
The gateway SHALL accept a JSON HTTP POST at `/heartbeat` containing a `device` object from a resident Engine service.

#### Scenario: Required device heartbeat endpoint behavior
- **WHEN** an Agent changes session intent or an Engine sends a heartbeat
- **THEN** The gateway SHALL return a JSON response containing an integer `intervalSeconds` that tells the Engine when to send its next device heartbeat.
- **AND** The response MUST be 120 when no Agent-controlled session is open or wanted and 5 while an Agent-controlled session is wanted and no WebSocket is live.
- **AND** When a session is wanted and no WebSocket is live, the response MUST also contain a non-empty one-time `token`, non-empty `sessionId`, a session endpoint whose origin is the configured Gateway origin, and an absolute `leaseExpiresAt` timestamp.
- **AND** The token MUST expire 30 seconds after issuance.
- **AND** Repeated heartbeats while a token is pending MUST return the same token, session id, endpoint, and lease expiry without extending token expiry.
- **AND** When no session is wanted or a WebSocket is live, the response MUST NOT contain connection credentials.
- **AND** The heartbeat contract assumes the caller is a long-running Engine Runtime that uses the response only to acquire a session lease.

#### Scenario: Idle device heartbeat
- **WHEN** the engine POSTs device information while no session is wanted
- **THEN** the gateway returns HTTP 200 with `intervalSeconds` set to 120 and no session connection details

#### Scenario: Agent-controlled session lease
- **WHEN** an Agent has requested a session and the Engine posts valid device information while no socket is live
- **THEN** the gateway returns `intervalSeconds` 5, a one-time token, session id, Gateway-bound endpoint, and lease expiry

#### Scenario: Live or consumed session does not mint credentials
- **WHEN** the token has been consumed or a session WebSocket is live without a new session-wanted request
- **THEN** a heartbeat returns no session token

#### Scenario: Invalid heartbeat payload
- **WHEN** a client POSTs a heartbeat body that is not a JSON object containing a `device` object
- **THEN** the gateway returns HTTP 400

### Requirement: Session-wanted gateway control
The gateway SHALL provide a local JSON HTTP POST at `/session-wanted` that accepts a boolean `wanted` value and changes the session-wanted state used by subsequent heartbeat responses from the resident Engine. A successful authenticated session upgrade MUST set this state to false. A new token can be issued only after this endpoint has set the state to true after the prior session has ended.

#### Scenario: Request a session
- **WHEN** a client POSTs `{ "wanted": true }` to `/session-wanted` after no session is live
- **THEN** a subsequent valid device heartbeat from the Engine returns `intervalSeconds` set to 5 and pending session credentials

#### Scenario: Clear a session request
- **WHEN** a client POSTs `{ "wanted": false }` to `/session-wanted`
- **THEN** subsequent valid device heartbeats return `intervalSeconds` set to 120 without session credentials

#### Scenario: Invalid session-wanted payload
- **WHEN** a client POSTs a body without a boolean `wanted` value
- **THEN** the gateway returns HTTP 400

### Requirement: Agent session intent control
The gateway SHALL provide Agent-facing local control for opening, renewing, querying, and closing the one Engine session.

#### Scenario: Required agent session intent control behavior
- **WHEN** an Agent changes session intent or an Engine sends a heartbeat
- **THEN** It MUST record session ownership and desired state, issue or extend leases only for the active Agent-controlled session, and relay valid renew and close control messages to a ready Engine WebSocket.
- **AND** A close request MUST clear the wanted state and cause subsequent heartbeats to return the idle interval.
- **AND** A renewal MUST NOT extend a session beyond Gateway or Engine policy maxima.

#### Scenario: Agent renews a live session
- **WHEN** the active Agent renews its live session before its lease expires
- **THEN** the gateway records a new bounded expiry and sends a valid `session.renew` message to the bound Engine

#### Scenario: Agent closes a live session
- **WHEN** the active Agent requests closure of its session
- **THEN** the gateway sends `session.close`, stops accepting new session RPC after draining begins, and subsequent heartbeats return the idle interval

### Requirement: Optional session intent binding
`POST /session/open` MUST accept an optional non-empty caller-selected `sessionId`, otherwise generate one, and expose it in the open reply and wanted status before heartbeat acquisition.

#### Scenario: Required optional session intent binding behavior
- **WHEN** an Agent changes session intent or an Engine sends a heartbeat
- **THEN** The acquired Engine lease MUST use that intent id.
- **AND** Renew and close controls MAY contain a `sessionId`; supplied ids MUST match the pending or live intent.
- **AND** Omitting the id MUST retain the legacy single-session behavior.
- **AND** While a wanted or pending intent exists, opening with another supplied id MUST return HTTP 409 without changing pending credentials.
- **AND** Opening with the same id, or omitting an id through the legacy single-session API, MUST be idempotent and preserve the pending token and lease.

#### Scenario: Repeat an open while the Engine is connecting
- **WHEN** a controller retries an open for its existing intent after heartbeat credentials were issued
- **THEN** the Gateway preserves the token, session id, token expiry, and lease expiry and the Engine can still connect

#### Scenario: Stale close cannot cancel a replacement intent
- **WHEN** a controller closes with a session id different from the currently wanted or live session
- **THEN** the Gateway returns HTTP 409 and preserves the current session

### Requirement: Request deadlines preserve unrelated work
A caller deadline earlier than the Gateway RPC timeout MUST return a request-scoped `DEADLINE_EXCEEDED` without closing the session or rejecting other pending requests. The Gateway's own RPC timeout MUST still bound forwarding and close an unresponsive session. Timed-out request ids MUST remain protected by the bounded deduplication window. Pending RPC work MUST count as activity for the Gateway idle timer.

#### Scenario: A shorter caller deadline expires behind other work
- **WHEN** one caller's earlier deadline elapses while other RPCs are pending
- **THEN** the caller receives a deadline error and the other RPCs may complete on the same session

### Requirement: Uncertain request identities survive teardown
The Gateway MUST retain a bounded window of up to 4,096 request ids across session teardown for Gateway timeouts, Engine `DEADLINE_EXCEEDED` or `SESSION_CLOSED` errors, and forwarded requests that lose their reply on disconnect. Retrying an id still in that window MUST return a duplicate-request rejection without forwarding it again. This in-memory protection MUST NOT be described as durable exactly-once execution after process restart or eviction.

#### Scenario: Engine reports a deadline before disconnecting
- **WHEN** an Engine returns a deadline error for a forwarded request and the session later closes
- **THEN** the same id cannot be forwarded on the next session while it remains in the uncertain-id window
