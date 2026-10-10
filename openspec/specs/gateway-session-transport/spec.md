## Purpose

Defines the bounded, authenticated session transport between a Reach engine and its local gateway.

## Requirements

### Requirement: Authenticated renewable engine session
The gateway SHALL accept an Engine WebSocket connection only when it presents the currently issued, unexpired session token and no session WebSocket is live.

#### Scenario: Required authenticated renewable engine session behavior
- **WHEN** the Gateway accepts or uses an Engine WebSocket
- **THEN** On successful upgrade it MUST consume the token, retain the Agent-controlled session state, and bind the WebSocket to the issued session id and lease.
- **AND** The gateway MUST reject a connection with a missing, invalid, expired, already-consumed token, wrong configured origin, or while another session WebSocket is open; rejection MUST not create a session.
- **AND** After accepting the session, the Gateway is the sole originator of data-plane filesystem `request` envelopes on that socket; the connected Engine is the executor.
- **AND** The gateway MUST wait for valid `session.ready` before forwarding data-plane requests.

#### Scenario: Engine connects with issued credentials
- **WHEN** an Engine connects with the currently issued token before its 30-second expiry and no session is live
- **THEN** the gateway accepts the WebSocket, consumes the token, binds the session id and lease, and waits for Engine readiness

#### Scenario: Invalid credential is rejected
- **WHEN** a client connects with no token, a stale or consumed token, an endpoint for a different configured origin, or while another session WebSocket remains open
- **THEN** the gateway rejects the WebSocket upgrade and does not create a second session

#### Scenario: Ready Engine receives an Agent RPC
- **WHEN** a session is live and ready and an Agent filesystem request is valid
- **THEN** the gateway sends a complete `reach-rpc/1.0` request envelope to the Engine and waits for the matching `response` or `error`

### Requirement: Agent-controlled session closure and Engine policy closure
The gateway SHALL keep a ready session open until the Agent requests close, the Engine reports policy closure, or the transport ends. On Agent close it MUST send `session.close` and stop forwarding new data-plane requests. On Engine `session.closed`, timeout, lease expiry, or transport closure it MUST clear the live session binding, expose the closure reason, and require a new Agent open request before issuing another token.

#### Scenario: Engine expires an abandoned lease
- **WHEN** the Engine sends `session.closed` with reason `lease_expired`
- **THEN** the gateway clears the live session and reports the closure without attempting to reuse the old session id

### Requirement: Bounded and valid session messages
The gateway SHALL reject WebSocket text messages larger than 1 MiB and SHALL close a session after the Engine or Gateway policy deadline.

#### Scenario: Required bounded and valid session messages behavior
- **WHEN** the Gateway accepts or uses an Engine WebSocket
- **THEN** Every data-plane request the gateway sends MUST be a complete `reach-rpc` version `1.0` request envelope with non-empty `sessionId`, `requestId`, and `method`, object `params`, and a session id equal to the bound connection.
- **AND** The Engine MUST answer each such request with a `response` or `error` that echoes `requestId`.
- **AND** The gateway MUST relay valid session control messages and MUST ignore inbound Engine filesystem `request` envelopes for dispatch purposes.
- **AND** Malformed data-plane or control messages MUST NOT dispatch filesystem work.

#### Scenario: Reject incomplete request envelope
- **WHEN** a session party sends a filesystem request missing `requestId` or using another protocol or version
- **THEN** the peer responds with `INVALID_PARAMS` without dispatching the request

#### Scenario: Reject a request for another session
- **WHEN** a party sends an otherwise valid request whose `sessionId` differs from the WebSocket session identifier
- **THEN** the peer responds with `INVALID_PARAMS`

#### Scenario: Bound a stalled or oversized session
- **WHEN** a session exceeds its hard timeout, idle timeout, or text-message limit
- **THEN** the gateway closes it and releases its session resources

#### Scenario: Reject oversized frames before application buffering
- **WHEN** an engine peer sends a WebSocket text frame larger than 1 MiB
- **THEN** the WebSocket layer rejects the frame via `maxPayload` and the gateway closes the session without treating the oversized payload as a valid RPC message

#### Scenario: Engine-originated filesystem requests are not dispatched by gateway
- **WHEN** the engine sends a `type=request` filesystem envelope on the live session
- **THEN** the gateway does not execute filesystem operations against a gateway-local workspace

### Requirement: Local session RPC proxy
While a ready Engine session is live and not draining, the gateway SHALL accept a local JSON `POST /session/rpc` body that is a complete `reach-rpc/1.0` request envelope (or sufficient fields for the gateway to fill the bound `sessionId`) and forward it to the Engine over the WebSocket.

#### Scenario: Required local session rpc proxy behavior
- **WHEN** the Gateway accepts or uses an Engine WebSocket
- **THEN** The gateway MUST return the Engine’s `response` or `error` payload to the HTTP caller.
- **AND** When no ready session is live or draining has started, the gateway MUST return HTTP 409 or 503 without inventing filesystem results.
- **AND** Mutation methods MUST pass grant validation before forward as required by `gateway-write-grants`.
- **AND** The gateway MUST reject nested `tool.call` (a `tool.call` whose unwrap leaves a `tool.call`, or whose unwrap fails) with `INVALID_PARAMS` before grant matching and MUST NOT forward it.
- **AND** The gateway MUST allow at most 16 concurrent pending forwarded RPCs; an additional request while 16 are outstanding MUST return HTTP 503 without forwarding.
- **AND** When a forwarded RPC exceeds the session RPC timeout, the gateway MUST fail that waiter with an error, close the live session WebSocket to abort in-flight Engine work, and fail any other pending waiters for that session.
- **AND** Timed-out request identifiers MUST be retained in a bounded set that survives session teardown, and a later retry of a timed-out `requestId` MUST be rejected as a duplicate (HTTP 409) rather than re-executed, because the Engine may already have applied the timed-out mutation on disk.

#### Scenario: Forward a read through the gateway
- **WHEN** an engine session is live and a caller POSTs a valid `fs.read` envelope to `/session/rpc`
- **THEN** the gateway forwards the request, waits for the engine reply, and returns that result to the caller

#### Scenario: Reject RPC without a live session
- **WHEN** a caller POSTs to `/session/rpc` while no engine WebSocket is live
- **THEN** the gateway returns an error status and does not fabricate filesystem data

#### Scenario: Reject RPC while session is draining
- **WHEN** a caller posts to `/session/rpc` after Agent close, Engine expiry, or timeout has begun draining
- **THEN** the gateway returns an error status and does not forward the request

#### Scenario: Reject nested tool.call before forward
- **WHEN** a caller POSTs `tool.call` whose nested leaf method is still `tool.call`
- **THEN** the gateway returns `INVALID_PARAMS` and does not forward the envelope to the Engine

#### Scenario: Cap concurrent pending RPCs
- **WHEN** 16 forwarded RPCs are already awaiting Engine replies and a caller POSTs another `/session/rpc`
- **THEN** the gateway returns HTTP 503 and does not forward the new request

#### Scenario: Timeout closes the live session
- **WHEN** a forwarded `/session/rpc` exceeds the session RPC timeout before an Engine reply arrives
- **THEN** the gateway returns an error to that caller, closes the live session WebSocket, rejects other pending RPC waiters for that session, and retains the timed-out `requestId` for later duplicate rejection

#### Scenario: Retry of a timed-out requestId is rejected after reconnect
- **WHEN** a caller retries a `requestId` that previously timed out, after the session has been re-established
- **THEN** the gateway rejects the retry as a duplicate and does not forward it

### Requirement: Connecting session timeout
The gateway SHALL close a live Engine WebSocket that has not sent a valid `session.ready` within a connecting bound. The default bound MUST be 15 seconds and MUST be overridable for tests. After that close, the live session binding MUST be cleared so a later Agent `/session/open` is accepted. The gateway MUST still reject `/session/open` with `session already active` while a live WebSocket exists, including during the connecting window.

#### Scenario: Engine connects but never becomes ready
- **WHEN** an Engine WebSocket upgrades successfully and does not send valid `session.ready` before the connecting bound
- **THEN** the gateway closes that WebSocket and a subsequent `/session/open` succeeds

#### Scenario: Open remains rejected while connecting
- **WHEN** an Engine WebSocket is live and has not yet sent `session.ready`
- **THEN** `/session/open` returns HTTP 409 with `session already active`

### Requirement: Malformed ingress is isolated
The Gateway MUST catch HTTP and upgrade request-target parsing errors and return 400. It MUST parse Engine JSON as unknown and validate object and message schemas before accessing fields or resolving RPC waiters. Invalid payloads MUST be rejected without terminating the shared process or disrupting another Engine session.

#### Scenario: Malformed targets and primitive Engine frames
- **WHEN** a client sends an invalid URL target or an Engine sends null, an array, a primitive, or an invalid response/control object
- **THEN** the Gateway remains alive, health succeeds, and another Engine session completes RPC

### Requirement: Serialized response byte budget
Engine responses MUST fit the shared 1 MiB serialized WebSocket budget, counting JSON escaping and envelope fields including requestId. Results exceeding that budget MUST return RESPONSE_TOO_LARGE without closing the session. The limit MUST agree with fixtures/rpc-limits.json and Gateway policy.

#### Scenario: Long or heavily escaped file content
- **WHEN** fs.read would exceed the budget through a long line, UTF-8 bytes or JSON escaping
- **THEN** a bounded error is returned and subsequent RPCs on that session and another Engine session succeed
