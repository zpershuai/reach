## Purpose

Defines the bounded, authenticated session transport between a Reach engine and its local gateway.

## Requirements

### Requirement: Authenticated short-lived engine session
The gateway SHALL accept an engine WebSocket connection only when it presents the currently issued, unexpired session token and no session WebSocket is live. On successful upgrade it MUST consume the token and set the pending session-wanted state to false. The gateway MUST reject a connection with a missing, invalid, expired, already-consumed token, or while another session is open; rejection MUST not create a session. After accepting the session, the gateway (or a controller attached through the gateway) is the sole originator of filesystem `request` envelopes on that socket; the connected engine is the executor.

#### Scenario: Engine connects with issued credentials
- **WHEN** an engine connects with the currently issued token before its 30-second expiry and no session is live
- **THEN** the gateway accepts the WebSocket session, consumes the token, clears session-wanted, and records a connection event

#### Scenario: Invalid credential is rejected
- **WHEN** a client connects with no token, a stale or consumed token, or while a session WebSocket remains open
- **THEN** the gateway rejects the WebSocket upgrade and does not create a second session

#### Scenario: Gateway drives session requests
- **WHEN** a session is live and filesystem work is required
- **THEN** the gateway sends complete `reach-rpc/1.0` request envelopes to the engine and waits for matching `response` or `error` messages

### Requirement: Job completion closes the session
The engine SHALL send a job-complete signal after the gateway-driven job finishes. Upon receiving that signal, the gateway MUST close that WebSocket and clear any pending session credentials so later heartbeats return the idle interval without session connection details. The gateway MUST log or otherwise expose the accepted connection and its closure for integration verification.

#### Scenario: Stub job completes
- **WHEN** an authenticated engine sends the job-complete signal after handling gateway requests
- **THEN** the gateway records the completion, closes that engine's WebSocket, and subsequent heartbeats return `intervalSeconds` 120 without `wssUrl` or `token`

#### Scenario: Session remains bounded
- **WHEN** the gateway has closed a completed, idle, or timed-out session
- **THEN** no WebSocket remains open solely to wait for future work

### Requirement: Bounded and valid session messages
The gateway SHALL reject WebSocket text messages larger than 1 MiB and SHALL close a session after five minutes total duration or 60 seconds without inbound activity. Every filesystem `request` the gateway sends MUST be a complete `reach-rpc` version `1.0` request envelope with non-empty `sessionId`, `requestId`, and `method`, and object `params`; its `sessionId` MUST equal the identifier bound to that connection. The engine MUST answer each such request with a `response` or `error` that echoes `requestId`. A malformed request, wrong protocol/version, absent request identifier, or mismatched session identifier MUST produce an `INVALID_PARAMS` error and MUST NOT dispatch a filesystem operation on the engine. The gateway MUST ignore inbound filesystem `request` envelopes from the engine for dispatch purposes.

#### Scenario: Reject incomplete request envelope
- **WHEN** a session party sends a filesystem request missing `requestId` or using another protocol or version
- **THEN** the peer responds with `INVALID_PARAMS` without dispatching the request

#### Scenario: Reject a request for another session
- **WHEN** a party sends an otherwise valid request whose `sessionId` differs from the WebSocket session identifier
- **THEN** the peer responds with `INVALID_PARAMS`

#### Scenario: Bound a stalled or oversized session
- **WHEN** a session exceeds its hard timeout, idle timeout, or text-message limit
- **THEN** the gateway closes it and releases its session resources

#### Scenario: Engine-originated filesystem requests are not dispatched by gateway
- **WHEN** the engine sends a `type=request` filesystem envelope on the live session
- **THEN** the gateway does not execute filesystem operations against a gateway-local workspace

### Requirement: Local session RPC proxy
While an engine session is live, the gateway SHALL accept a local JSON `POST /session/rpc` body that is a complete `reach-rpc/1.0` request envelope (or sufficient fields for the gateway to fill the bound `sessionId`) and forward it to the engine over the WebSocket. The gateway MUST return the engine’s `response` or `error` payload to the HTTP caller. When no session is live, the gateway MUST return HTTP 409 or 503 without inventing filesystem results. Mutation methods MUST pass grant validation before forward as required by `gateway-write-grants`.

#### Scenario: Forward a read through the gateway
- **WHEN** an engine session is live and a caller POSTs a valid `fs.read` envelope to `/session/rpc`
- **THEN** the gateway forwards the request, waits for the engine reply, and returns that result to the caller

#### Scenario: Reject RPC without a live session
- **WHEN** a caller POSTs to `/session/rpc` while no engine WebSocket is live
- **THEN** the gateway returns an error status and does not fabricate filesystem data
