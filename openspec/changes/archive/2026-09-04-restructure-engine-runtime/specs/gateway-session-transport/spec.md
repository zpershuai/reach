## MODIFIED Requirements

### Requirement: Authenticated renewable engine session
The gateway SHALL accept an Engine WebSocket connection only when it presents the currently issued, unexpired session token and no session WebSocket is live. On successful upgrade it MUST consume the token, retain the Agent-controlled session state, and bind the WebSocket to the issued session id and lease. The gateway MUST reject a connection with a missing, invalid, expired, already-consumed token, wrong configured origin, or while another session WebSocket is open; rejection MUST not create a session. After accepting the session, the Gateway is the sole originator of data-plane filesystem `request` envelopes on that socket; the connected Engine is the executor. The gateway MUST wait for valid `session.ready` before forwarding data-plane requests.

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
The gateway SHALL reject WebSocket text messages larger than 1 MiB and SHALL close a session after the Engine or Gateway policy deadline. Every data-plane request the gateway sends MUST be a complete `reach-rpc` version `1.0` request envelope with non-empty `sessionId`, `requestId`, and `method`, object `params`, and a session id equal to the bound connection. The Engine MUST answer each such request with a `response` or `error` that echoes `requestId`. The gateway MUST relay valid session control messages and MUST ignore inbound Engine filesystem `request` envelopes for dispatch purposes. Malformed data-plane or control messages MUST NOT dispatch filesystem work.

#### Scenario: Engine-originated filesystem request is not dispatched by gateway
- **WHEN** the Engine sends a `type=request` filesystem envelope on the live session
- **THEN** the gateway does not execute filesystem operations against a gateway-local workspace

### Requirement: Local session RPC proxy
While a ready Engine session is live and not draining, the gateway SHALL accept a local JSON `POST /session/rpc` body that is a complete `reach-rpc/1.0` request envelope (or sufficient fields for the gateway to fill the bound `sessionId`) and forward it to the Engine over the WebSocket. The gateway MUST return the Engine’s `response` or `error` payload to the HTTP caller. When no ready session is live or draining has started, the gateway MUST return HTTP 409 or 503 without inventing filesystem results. Mutation methods MUST pass grant validation before forward as required by `gateway-write-grants`.

#### Scenario: Reject RPC while session is draining
- **WHEN** a caller posts to `/session/rpc` after Agent close, Engine expiry, or timeout has begun draining
- **THEN** the gateway returns an error status and does not forward the request
