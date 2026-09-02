## Why

Round 2 can request a fast heartbeat but cannot establish the short-lived session needed to perform work. Round 3 adds a single authenticated session that ends as soon as its job completes, rather than keeping a permanent connection open.

## What Changes

- Return one-time WebSocket connection details with a session-wanted heartbeat response.
- Add a local gateway WebSocket session that accepts an authenticated engine, receives a stub job-complete signal, and closes that socket.
- Add a Rust engine session client that consumes the heartbeat-issued connection details and reports job completion.

## Capabilities

### New Capabilities
- `gateway-session-transport`: Authenticated, short-lived gateway/engine WebSocket sessions that close after job completion.

### Modified Capabilities
- `gateway-heartbeat`: A session-wanted heartbeat returns session connection details in addition to the fast polling interval.

## Impact

Affected code includes the TypeScript gateway HTTP server and tests, the Rust workspace engine binary, and local integration proof. This introduces compatible WebSocket client/server dependencies while leaving the Reach RPC DTO contract and filesystem serving out of scope.
