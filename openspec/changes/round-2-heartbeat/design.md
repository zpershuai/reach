## Context

See proposal.md for motivation and specs/gateway-heartbeat/spec.md for the observable contract. The repository already has a private TypeScript package with Node type definitions and no HTTP service. Round 1's `reach-rpc/1.0` DTO contract remains unchanged.

## Goals / Non-Goals

**Goals:**

- Run one local HTTP gateway process that accepts device heartbeats and returns its selected polling interval.
- Keep the session-wanted switch explicit and easy to exercise from `curl`.
- Validate malformed JSON and required object/boolean shapes at the HTTP boundary.

**Non-Goals:**

- Persisting device data or session state across a gateway restart.
- Identifying, authorizing, or routing sessions per device.
- WSS connections, WSS credentials, filesystem RPC serving, or Grok Bot plugin work.

## Decisions

### Node built-in HTTP server

The gateway will use Node's built-in `http` module, exposed by a TypeScript `gateway` entry point. This keeps the local service dependency-free beyond the existing TypeScript package and makes the proof runnable with a built artifact. An HTTP framework was considered but would add a dependency without changing this two-route interface.

### Small JSON endpoint contract

`POST /heartbeat` accepts `{ "device": { ... } }` and replies `{ "intervalSeconds": 120 | 5 }`. `POST /session-wanted` accepts `{ "wanted": boolean }` and returns the resulting state. Both endpoints reject malformed or wrong-shaped JSON with HTTP 400. This requires the engine to carry opaque device information while avoiding premature device identity or schema decisions.

### In-memory gateway-wide session intent

The process owns one boolean `sessionWanted`, initially false. The session control mutates it and heartbeat responses read it. This is sufficient for the local single-engine target; a keyed, persistent session store was rejected because no per-device behavior is required yet.

### Loopback default and configurable port

The gateway listens on `127.0.0.1` and defaults to port 8787, with an environment-variable port override for local use. Binding publicly was rejected because the Round 2 control endpoint has no authentication.

## Risks / Trade-offs

- [Gateway restart clears the requested session] → The engine falls back to the specified 120-second interval until the local control requests a session again.
- [Global state cannot represent multiple device session intents] → Add per-device state only in a later spec change when multi-device behavior is defined.
- [Opaque device payload has limited validation] → Keep only the required object boundary until the device inventory schema is specified.

## Migration Plan

1. Build the TypeScript package and start the loopback gateway.
2. POST a device object and confirm the idle 120-second response.
3. POST the session-wanted control, then confirm the 5-second response.
4. Roll back by stopping the standalone gateway process and reverting the implementation commit; no data migration is needed.
