## Context

The gateway is a local TypeScript HTTP service with a heartbeat control plane (see `proposal.md` and the Round 2 heartbeat spec). The Rust workspace already owns the portable Reach RPC DTOs, but no long-lived transport or filesystem serving. Round 3 needs one cross-language, short-lived connection without changing that RPC contract.

## Goals / Non-Goals

**Goals:**

- Extend the heartbeat response only for an active session request with a WebSocket URL and opaque, one-time token.
- Let a Rust binary perform one heartbeat, connect to that URL, send a stub completion signal, and observe the gateway close the connection.
- Make the gateway's connect and close events observable in automated tests and the local gateway log.

**Non-Goals:**

- Serving any filesystem RPC method or dispatching real jobs.
- Keeping an engine connection alive while the gateway is idle.
- Building a Grok Bot plugin, a remote service, TLS deployment, or iStoreOS deployment.

## Decisions

### Issue credentials from the session-wanted heartbeat

The gateway will create a random opaque token for the pending session and include it with `wssUrl` in the existing fast heartbeat response. It will retain only one pending token and consume it at WebSocket upgrade. This builds on the existing engine polling path instead of creating a second control API.

Alternative considered: a separate session-credentials endpoint. This would add another polling interaction without improving the one-session requirement.

### Use a WebSocket endpoint with query-token authentication

The local gateway will expose a `/session` WebSocket endpoint. The engine supplies the issued token during the initial URL connection; a nonmatching or already-used token receives an upgrade rejection. The response field is named `wssUrl` as the transport-facing connection URL; this local, loopback proof uses `ws://` because it has no TLS termination. A deployed TLS terminator can make the same endpoint `wss://` without changing the heartbeat or engine contract.

Alternative considered: an always-open socket authenticated after connection. This conflicts with the bounded-session goal and leaves unnecessary idle pipes.

### Represent the stub job with one completion message

After an accepted connection, the engine sends a small JSON `job.done` message. The gateway records the event, clears session-wanted state, and closes the socket. Tests await the close event rather than relying on timing.

Alternative considered: server-initiated close immediately after upgrade. That would not demonstrate the required engine completion signal.

### Keep the engine as a small Rust binary in the existing crate

The `reach-rpc` crate gains a `session-client` binary using HTTP for the heartbeat and a WebSocket client for the one-shot session. This keeps the proof in the existing workspace and avoids broad crate or deploy structure.

Alternative considered: a sibling engine crate. It adds workspace setup without a meaningful boundary at this stage.

## Risks / Trade-offs

- [Single in-memory pending token is lost on gateway restart] → This is acceptable for the local proof; the engine will retry its normal heartbeat.
- [Loopback proof is unencrypted] → The protocol exposes a `wssUrl` field and deployment can terminate TLS; no TLS or deployment system is introduced in this round.
- [A peer never sends completion] → The gateway has no idle session purpose; tests cover the successful close path and future timeout policy remains outside scope.

## Migration Plan

1. Add the optional heartbeat session fields while retaining the idle 120-second and session-wanted 5-second interval behavior.
2. Add the authenticated WebSocket endpoint and Rust one-shot engine binary.
3. Prove an emitted connection event followed by a closure event in the integration test and local logs.
4. Roll back by removing session-wanted state or restarting the local gateway; idle heartbeats continue without connection details.
