## Purpose

Defines the bounded, authenticated session transport between a Reach engine and its local gateway.

## Requirements

### Requirement: Authenticated short-lived engine session
The gateway SHALL accept an engine WebSocket connection only when it presents the currently issued, unexpired session token and no session WebSocket is live. On successful upgrade it MUST consume the token and set the pending session-wanted state to false. The gateway MUST reject a connection with a missing, invalid, expired, already-consumed token, or while another session is open; rejection MUST not create a session.

#### Scenario: Engine connects with issued credentials
- **WHEN** an engine connects with the currently issued token before its 30-second expiry and no session is live
- **THEN** the gateway accepts the WebSocket session, consumes the token, clears session-wanted, and records a connection event

#### Scenario: Invalid credential is rejected
- **WHEN** a client connects with no token, a stale or consumed token, or while a session WebSocket remains open
- **THEN** the gateway rejects the WebSocket upgrade and does not create a second session

### Requirement: Job completion closes the session
The engine SHALL send a job-complete signal after its stub job finishes. Upon receiving that signal, the gateway MUST close that WebSocket and clear any pending session credentials so later heartbeats return the idle interval without session connection details. The gateway MUST log or otherwise expose the accepted connection and its closure for integration verification.

#### Scenario: Stub job completes
- **WHEN** an authenticated engine sends the job-complete signal
- **THEN** the gateway records the completion, closes that engine's WebSocket, and subsequent heartbeats return `intervalSeconds` 120 without `wssUrl` or `token`

#### Scenario: Session remains bounded
- **WHEN** the gateway has closed a completed, idle, or timed-out session
- **THEN** no WebSocket remains open solely to wait for future work
### Requirement: Bounded and valid session messages
The gateway SHALL reject WebSocket text messages larger than 1 MiB and SHALL close a session after five minutes total duration or 60 seconds without inbound activity. Every message with `type` equal to `request` MUST be a complete `reach-rpc` version `1.0` request envelope with non-empty `sessionId`, `requestId`, and `method`, and object `params`; its `sessionId` MUST equal the identifier bound to that connection. A malformed request, wrong protocol/version, absent request identifier, or mismatched session identifier MUST receive an `INVALID_PARAMS` error and MUST NOT dispatch a filesystem operation.

#### Scenario: Reject incomplete request envelope
- **WHEN** an engine sends a request missing `requestId` or using another protocol or version
- **THEN** the gateway responds with `INVALID_PARAMS` without dispatching the request

#### Scenario: Reject a request for another session
- **WHEN** an engine sends an otherwise valid request whose `sessionId` differs from the WebSocket session identifier
- **THEN** the gateway responds with `INVALID_PARAMS`

#### Scenario: Bound a stalled or oversized session
- **WHEN** a session exceeds its hard timeout, idle timeout, or text-message limit
- **THEN** the gateway closes it and releases its session resources

