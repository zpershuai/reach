## Purpose

Defines the bounded, authenticated session transport between a Reach engine and its local gateway.

## ADDED Requirements

### Requirement: Authenticated short-lived engine session
The gateway SHALL accept an engine WebSocket connection only when it presents the currently issued session token. An engine that receives `wssUrl` and `token` from a session-wanted heartbeat MUST connect using those details. The gateway MUST reject a connection with a missing, invalid, or already-consumed token.

#### Scenario: Engine connects with issued credentials
- **WHEN** the engine connects to the issued `wssUrl` using the issued token
- **THEN** the gateway accepts the WebSocket session and records a connection event

#### Scenario: Invalid credential is rejected
- **WHEN** a client connects without the currently issued token
- **THEN** the gateway rejects the WebSocket upgrade and does not create a session

### Requirement: Job completion closes the session
The engine SHALL send a job-complete signal after its stub job finishes. Upon receiving that signal, the gateway MUST close that WebSocket and clear the pending session request so later heartbeats return the idle interval without session connection details. The gateway MUST log or otherwise expose the accepted connection and its closure for integration verification.

#### Scenario: Stub job completes
- **WHEN** an authenticated engine sends the job-complete signal
- **THEN** the gateway records the completion, closes that engine's WebSocket, and subsequent heartbeats return `intervalSeconds` 120 without `wssUrl` or `token`

#### Scenario: Session remains bounded
- **WHEN** the gateway has closed a completed session
- **THEN** no WebSocket remains open solely to wait for future work
