## Purpose

Defines the local gateway heartbeat loop that lets the engine report device information and receive its next polling interval, plus optional one-time session connection details.

## Requirements

### Requirement: Device heartbeat endpoint
The gateway SHALL accept a JSON HTTP POST at `/heartbeat` containing a `device` object from a resident Engine service.

#### Scenario: Required device heartbeat endpoint behavior
- **WHEN** an Agent changes session intent or an Engine sends a heartbeat
- **THEN** The gateway SHALL return a JSON response containing an integer `intervalSeconds` that tells the Engine when to send its next device heartbeat.
- **AND** When no session is wanted or a WebSocket is live, `intervalSeconds` MUST use the configured positive idle heartbeat interval (`REACH_HEARTBEAT_INTERVAL_SECS`, default 120); while a session is wanted and no WebSocket is live, it MUST be 5.
- **AND** When a session is wanted and no WebSocket is live, the response MUST also contain a non-empty one-time `token`, non-empty `sessionId`, a session endpoint whose origin is the configured Gateway origin, and an absolute `leaseExpiresAt` timestamp.
- **AND** The token MUST expire 30 seconds after issuance.
- **AND** Repeated heartbeats while a token is pending MUST return the same token, session id, endpoint, and lease expiry without extending token expiry.
- **AND** When no session is wanted or a WebSocket is live, the response MUST NOT contain connection credentials.
- **AND** The heartbeat contract assumes the caller is a long-running Engine Runtime that uses the response only to acquire a session lease.

#### Scenario: Idle device heartbeat
- **WHEN** the engine POSTs device information while no session is wanted
- **THEN** the gateway returns HTTP 200 with `intervalSeconds` set to the configured idle interval (120 by default) and no session connection details

#### Scenario: Configured idle heartbeat
- **WHEN** the Gateway starts with `REACH_HEARTBEAT_INTERVAL_SECS=15` and the Engine heartbeats while no session is wanted
- **THEN** the gateway returns `intervalSeconds` 15 without session credentials

#### Scenario: Agent-controlled session lease
- **WHEN** an Agent has requested a session and the Engine posts valid device information while no socket is live
- **THEN** the gateway returns `intervalSeconds` 5, a one-time token, session id, Gateway-bound endpoint, and lease expiry

#### Scenario: Live or consumed session does not mint credentials
- **WHEN** the token has been consumed or a session WebSocket is live without a new session-open intent
- **THEN** a heartbeat returns no session token

#### Scenario: Invalid heartbeat payload
- **WHEN** a client POSTs a heartbeat body that is not a JSON object containing a `device` object
- **THEN** the gateway returns HTTP 400

### Requirement: Legacy session-wanted gateway control
The gateway SHALL retain `/session-wanted` as a compatibility alias accepting a boolean `wanted`: `true` uses the session-open intent flow and `false` uses the session-close flow. New clients SHOULD use `/session/open` and `/session/close`. A successful authenticated session upgrade MUST set the wanted state to false. A new session after the prior session has ended MUST require a new open intent, requested through `/session/open` or the legacy alias; use of the alias MUST NOT be required.

#### Scenario: Request a session
- **WHEN** a client POSTs `{ "wanted": true }` to `/session-wanted` after no session is live
- **THEN** a subsequent valid device heartbeat from the Engine returns `intervalSeconds` set to 5 and pending session credentials

#### Scenario: Clear a session request
- **WHEN** a client POSTs `{ "wanted": false }` to `/session-wanted`
- **THEN** subsequent valid device heartbeats return the configured idle interval without session credentials

#### Scenario: Invalid session-wanted payload
- **WHEN** a client POSTs a body without a boolean `wanted` value
- **THEN** the gateway returns HTTP 400

### Requirement: Agent session intent control
The gateway SHALL provide Agent-facing control through `/session/open`, `/session/renew`, `/session/status`, and `/session/close` for the selected Engine session.

#### Scenario: Open without the legacy alias
- **WHEN** a client POSTs `{}` to `/session/open` after no session is live
- **THEN** the gateway returns the new intent's `sessionId`, and a subsequent valid Engine heartbeat returns `intervalSeconds` 5 and session credentials bound to that id without any `/session-wanted` request

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

### Requirement: Optional device hardware descriptor
The heartbeat `device` object MAY include a `hardware` object with string fields `kind`, `model`, `os`, `osVersion` and `arch`. When it is present and valid, the Gateway SHALL record it as the Engine's latest hardware and expose it to the console. An invalid or oversized descriptor MUST be ignored without rejecting the heartbeat.

The limits are:
- each field at most 64 printable characters;
- `kind` one of the console device kinds, otherwise treated as `unknown`.

#### Scenario: Engine reports a Mac mini
- **WHEN** a heartbeat contains `device.hardware` `{kind:"mac-mini", model:"Mac mini (M4, 2024)", os:"macOS", osVersion:"15.6", arch:"arm64"}`
- **THEN** the heartbeat response is unchanged and the console shows that hardware for the Engine

#### Scenario: Malformed descriptor
- **WHEN** `device.hardware.model` is 500 characters long
- **THEN** the Gateway returns the normal heartbeat response and keeps the previously recorded hardware

#### Scenario: Descriptor absent
- **WHEN** an older Engine heartbeats without `device.hardware`
- **THEN** the heartbeat is accepted exactly as before

### Requirement: Heartbeats are observable events
Each authenticated, valid heartbeat SHALL update the Engine's last-seen time. When the console is enabled, it MUST also publish an `engine.heartbeat` event carrying the Engine id, the reported Engine version and the returned interval.

#### Scenario: Idle heartbeat in the console
- **WHEN** an idle Engine heartbeats and receives `intervalSeconds` 15
- **THEN** an `engine.heartbeat` event with interval 15 is published and the console pulses that Engine's link
