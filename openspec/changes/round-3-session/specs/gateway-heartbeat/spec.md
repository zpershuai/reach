## MODIFIED Requirements

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
