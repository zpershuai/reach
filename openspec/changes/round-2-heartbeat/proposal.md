## Why

The engine needs a small, reliable way to tell the local gateway that it is alive and learn how frequently to check again. This creates the Round 2 control loop before introducing sessions or a WebSocket transport.

## What Changes

- Add a local TypeScript HTTP gateway endpoint that accepts engine device-information heartbeats.
- Return a requested next-heartbeat interval of 120 seconds by default and 5 seconds when a session is wanted.
- Provide a local gateway control that flips the session-wanted state so the shorter interval can be requested and demonstrated.
- Keep the response limited to the heartbeat interval; any future WSS URL or token is optional and unused.

## Capabilities

### New Capabilities

- `gateway-heartbeat`: Defines the Round 2 device heartbeat request, next-interval response, and session-wanted control behavior.

### Modified Capabilities

- None.

## Impact

- Adds a TypeScript gateway executable and its HTTP request/response DTOs.
- Adds local curl-based proof for both heartbeat frequencies.
- Preserves the `reach-rpc/1.0` Round 1 contract and adds no WSS, filesystem RPC serving, or Grok Bot plugin behavior.
