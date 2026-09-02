## MODIFIED Requirements

### Requirement: Device heartbeat endpoint
The gateway SHALL accept a JSON HTTP POST at `/heartbeat` containing a `device` object. The gateway SHALL return a JSON response containing an integer `intervalSeconds` that tells the engine when to send its next device heartbeat. The response MUST be 120 when no session is wanted and 5 when a session is wanted. When a session is wanted and no WebSocket is live, the response MUST also contain a non-empty `wssUrl` string and a non-empty one-time `token` string that expires 30 seconds after issuance. When no session is wanted or a WebSocket is live, it MUST NOT contain either field. Repeated heartbeats while a token is pending MUST return that pending token without extending its expiry.

#### Scenario: Idle device heartbeat
- **WHEN** the engine POSTs device information while no session is wanted
- **THEN** the gateway returns HTTP 200 with `intervalSeconds` set to 120 and no session connection details

#### Scenario: Session-wanted device heartbeat
- **WHEN** the engine POSTs device information while a session is wanted and no socket is live
- **THEN** the gateway returns HTTP 200 with `intervalSeconds` set to 5 plus a `wssUrl` and a token that expires in 30 seconds

#### Scenario: Live or consumed session does not mint credentials
- **WHEN** the token has been consumed or a session WebSocket is live without a new session-wanted request
- **THEN** a heartbeat returns no session token

#### Scenario: Invalid heartbeat payload
- **WHEN** a client POSTs a heartbeat body that is not a JSON object containing a `device` object
- **THEN** the gateway returns HTTP 400

### Requirement: Session-wanted gateway control
The gateway SHALL provide a local JSON HTTP POST at `/session-wanted` that accepts a boolean `wanted` value and changes the session-wanted state used by subsequent heartbeat responses. A successful authenticated session upgrade MUST set this state to false. A new token can be issued only after this endpoint has set the state to true after the prior session has ended.

#### Scenario: Request a session
- **WHEN** a client POSTs `{ "wanted": true }` to `/session-wanted` after no session is live
- **THEN** a subsequent valid device heartbeat returns `intervalSeconds` set to 5 and pending session credentials

#### Scenario: Clear a session request
- **WHEN** a client POSTs `{ "wanted": false }` to `/session-wanted`
- **THEN** subsequent valid device heartbeats return `intervalSeconds` set to 120 without session credentials

#### Scenario: Invalid session-wanted payload
- **WHEN** a client POSTs a body without a boolean `wanted` value
- **THEN** the gateway returns HTTP 400
