## Why

The current Rust Engine is a working Model B proof, but its lifecycle, transport handling, protocol parsing, authorization checks, and filesystem dispatch live in one orchestration path. That makes a long-lived Agent-controlled session difficult to reason about, test, extend with new tools, or safely recover after a transport failure.

Reach now needs a resident Engine Runtime for one configured Gateway: the Agent can intentionally open, renew, and close an interactive session, while the Engine independently bounds its lifetime and reliably returns to heartbeat mode after failure or expiry.

## What Changes

- Replace the Engine's nested heartbeat/session loop with an explicit single-Gateway runtime state machine: heartbeat, connect, active session, draining, backoff, and shutdown.
- Change the session model from a short task that ends at `session.complete` to an Agent-controlled, renewable session lease with explicit ready, renew, close, and closed control messages.
- Add Engine-enforced connection, RPC, idle, lease-expiry, and rotation limits; an expired or failed session is cleaned up and returns to heartbeat without resuming old state.
- Introduce a Dispatcher, authorization middleware, Tool registry, and typed per-tool handlers. Filesystem methods become independently testable tools backed by shared workspace services.
- Treat `tool.call` as a single-level compatibility adapter that canonicalizes to a direct method before dispatch; nested or malformed wrapping is rejected before a Tool runs.
- Pin the Engine to one configured Gateway origin and validate session endpoints against that configuration rather than accepting arbitrary heartbeat-provided endpoints.
- **BREAKING**: `session.complete` no longer defines the ordinary lifecycle of a successful session; explicit Agent/Gateway close or Engine policy expiry does. Existing clients must adopt session control and renewal.

## Capabilities

### New Capabilities

- `engine-runtime`: Single-Gateway resident runtime lifecycle, renewal leases, timeout policy, state cleanup, and recovery.
- `engine-tool-dispatch`: Dispatcher pipeline, Tool registry, compatibility adapter, execution policy, and Engine-side authorization boundary.

### Modified Capabilities

- `gateway-heartbeat`: Heartbeat becomes the Engine's session-lease acquisition path for an Agent-controlled session.
- `gateway-session-transport`: Add session control messages, renewable lifetime semantics, and Engine/Gateway close behavior.
- `edge-engine-service`: Replace short-job session handling with the Runtime and Tool-dispatch responsibilities.
- `workspace-filesystem-rpc`: Define how filesystem methods participate in the new dispatch, cancellation, and session-cleanup boundaries.
- `reach-rpc-contract`: Extend the portable control/message contract for session state and canonicalized tool dispatch.

## Impact

- Rust: split `crates/reach-rpc/src/bin/engine.rs` into runtime, transport, dispatch, tool, protocol, and workspace responsibilities; add focused unit and integration tests.
- TypeScript Gateway: evolve heartbeat/session control and WebSocket handling, preserve its role as the single Agent-facing control plane, and update tests.
- Protocol/API: introduce renewable session control messages and deprecate task-completion as the normal session lifecycle.
- Operations: one configured Gateway becomes a pinned Engine dependency; session observability gains lifecycle, lease, and timeout events.
