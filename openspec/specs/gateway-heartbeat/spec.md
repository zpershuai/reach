## Purpose

Defines the local gateway heartbeat loop that lets the engine report device information and receive its next polling interval, plus optional one-time session connection details.

## Requirements

### Requirement: Device heartbeat endpoint
The gateway SHALL accept a JSON HTTP POST at `/heartbeat` containing a `device` object. The gateway SHALL return a JSON response containing an integer `intervalSeconds` that tells the engine when to send its next device heartbeat. The response MUST be 120 when no session is wanted and 5 when a session is wanted. When a session is wanted, the response MUST also contain a non-empty `wssUrl` string and a non-empty `token` string for one pending session; when no session is wanted, it MUST NOT contain either field.

#### Scenario: Idle device heartbeat
- **WHEN** the engine POSTs device information while no session is wanted
- **THEN** the gateway returns HTTP 200 with `intervalSeconds` set to 120 and no session connection details

#### Scenario: Session-wanted device heartbeat
- **WHEN** the engine POSTs device information while a session is wanted
- **THEN** the gateway returns HTTP 200 with `intervalSeconds` set to 5 plus a `wssUrl` and `token` for the pending session

#### Scenario: Invalid heartbeat payload
- **WHEN** a client POSTs a heartbeat body that is not a JSON object containing a `device` object
- **THEN** the gateway returns HTTP 400

### Requirement: Session-wanted gateway control
The gateway SHALL provide a local JSON HTTP POST at `/session-wanted` that accepts a boolean `wanted` value and changes the session-wanted state used by subsequent heartbeat responses.

#### Scenario: Request a session
- **WHEN** a client POSTs `{ "wanted": true }` to `/session-wanted`
- **THEN** subsequent valid device heartbeats return `intervalSeconds` set to 5

#### Scenario: Clear a session request
- **WHEN** a client POSTs `{ "wanted": false }` to `/session-wanted`
- **THEN** subsequent valid device heartbeats return `intervalSeconds` set to 120

#### Scenario: Invalid session-wanted payload
- **WHEN** a client POSTs a body without a boolean `wanted` value
- **THEN** the gateway returns HTTP 400
