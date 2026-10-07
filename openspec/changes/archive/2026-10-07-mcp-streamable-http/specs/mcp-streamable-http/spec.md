## ADDED Requirements

### Requirement: Authenticated Streamable HTTP transport
The Gateway SHALL serve `/mcp` before Engine routing, authenticate every method with the Controller token, reject unapproved supplied Origins, and permit unauthenticated use only on loopback. It SHALL negotiate MCP 2025-03-26 or 2025-06-18, validate subsequent protocol headers, acknowledge notifications with empty 202, return GET 405, and support March batches after initialization. Received HTTP bodies MUST be bounded to 64 KiB; internal RPC metadata MUST NOT reduce this allowance, while forwarded WebSocket envelopes remain bounded.

#### Scenario: Missing credentials
- **WHEN** an authenticated Gateway receives an MCP request without the Controller token
- **THEN** it returns 401 before creating any session

#### Scenario: Session lifecycle
- **WHEN** a client initializes successfully
- **THEN** it receives a secure Mcp-Session-Id; later missing ids receive 400 and unknown or expired ids receive 404

### Requirement: Bounded owned sessions
HTTP sessions SHALL serialize work with bounded queues, expire after configurable inactivity, and close only Engine sessions they own on DELETE, expiry, or shutdown. Reading bodies, queued work, and running requests SHALL count toward per-session admission limits. Body reads SHALL prevent idle expiry within the request budget. Retirement SHALL immediately schedule serialized cleanup and reject subsequent tool dispatch, including requests still reading or queued. Requests SHALL use a configurable response budget defaulting to 25 seconds. The Gateway SHALL bound active HTTP sessions and preserve failed cleanup for retry.

#### Scenario: Another controller owns the Engine
- **WHEN** an MCP session tries to connect to an Engine already held by another owner
- **THEN** the tool returns ENGINE_BUSY and leaves the existing session intact

#### Scenario: Delete an owner
- **WHEN** the client deletes its MCP session
- **THEN** its owned Engine sessions drain and later requests using that MCP id receive 404

#### Scenario: Delete while a request is reading or queued
- **WHEN** DELETE retires a session with a POST still reading its body or waiting for dispatch
- **THEN** that POST receives 404 without opening an Engine intent or forwarding a mutation; already running work drains before cleanup

#### Scenario: Slow body within the response budget
- **WHEN** an admitted POST is still reading its body past the idle TTL but within the response budget
- **THEN** the session remains active and the request counts toward admission limits until it completes or fails

#### Scenario: Request discovers an expired session
- **WHEN** a request finds an idle session past its TTL before the next sweep
- **THEN** it returns 404 and immediately schedules owned Engine cleanup

#### Scenario: Near-limit write
- **WHEN** a valid MCP write fits within the 64 KiB received body limit but added internal metadata expands its RPC envelope
- **THEN** the Gateway accepts it while retaining RPC validation and the WebSocket envelope limit
