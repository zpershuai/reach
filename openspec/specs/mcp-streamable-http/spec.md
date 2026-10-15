## Purpose

Provides hosted, authenticated MCP access to registered Reach Engines.

## Requirements

### Requirement: Authenticated Streamable HTTP transport
The Gateway SHALL serve `/mcp` before Engine routing, authenticate every method with the Controller token, reject unapproved supplied Origins, and permit unauthenticated use only on loopback.

#### Scenario: Required authenticated streamable http transport behavior
- **WHEN** a client uses an HTTP MCP session
- **THEN** It SHALL negotiate MCP 2025-03-26 or 2025-06-18, validate subsequent protocol headers, acknowledge notifications with empty 202, return GET 405, and support March batches after initialization.
- **AND** Received HTTP bodies MUST be bounded to 64 KiB; internal RPC metadata MUST NOT reduce this allowance, while forwarded WebSocket envelopes remain bounded.

#### Scenario: Missing credentials
- **WHEN** an authenticated Gateway receives an MCP request without the Controller token
- **THEN** it returns 401 before creating any session

#### Scenario: Session lifecycle
- **WHEN** a client initializes successfully
- **THEN** it receives a secure Mcp-Session-Id; later missing ids receive 400 and unknown or expired ids receive 404

### Requirement: Bounded owned sessions
HTTP sessions SHALL serialize work with bounded queues, expire after configurable inactivity, and close only Engine sessions they own on DELETE, expiry, or shutdown.

#### Scenario: Required bounded owned sessions behavior
- **WHEN** a client uses an HTTP MCP session
- **THEN** Reading bodies, queued work, and running requests SHALL count toward per-session admission limits.
- **AND** Body reads SHALL prevent idle expiry within the request budget.
- **AND** Retirement SHALL immediately schedule serialized cleanup and reject subsequent tool dispatch, including requests still reading or queued.
- **AND** Requests SHALL use a configurable response budget defaulting to 25 seconds.
- **AND** The Gateway SHALL bound active HTTP sessions and preserve failed cleanup for retry.

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

### Requirement: HTTP MCP sessions are attributed
Each HTTP MCP session SHALL keep the `clientInfo` name and version from its `initialize` request as its ingress label. Every RPC, denial and Engine-session action it causes MUST be attributed to that label. Session creation and retirement MUST be published as `client.connected` and `client.disconnected` events when the console is enabled.

#### Scenario: Attributed tool call
- **WHEN** an HTTP MCP session initialized as `chatgpt 1.0` calls `fs_list`
- **THEN** the resulting audit record names client type `mcp-http` and label `chatgpt 1.0`

#### Scenario: Idle retirement
- **WHEN** an HTTP MCP session expires after inactivity
- **THEN** a `client.disconnected` event with reason `idle` is published

### Requirement: Console-initiated session retirement
The Gateway SHALL let the console retire every HTTP MCP session with a given ingress label. Retirement MUST follow the same path as a client DELETE. Later requests using a retired session id MUST receive 404, and the retirement MUST be recorded as an `admin.action`.

#### Scenario: Owner disconnects a bot
- **WHEN** the owner disconnects label `grok-bot 1.2` while it owns a ready Engine session
- **THEN** that Engine session drains and closes, and the bot's next request with its old `Mcp-Session-Id` receives 404
