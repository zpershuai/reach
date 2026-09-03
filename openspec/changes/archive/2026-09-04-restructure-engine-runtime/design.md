## Context

Reach Model B currently proves that a Rust Engine can heartbeat to a TypeScript Gateway, accept a one-time WebSocket session, and execute workspace RPC. Its `engine.rs` has intentionally compact orchestration: one synchronous loop performs heartbeat, connection setup, WebSocket reads, protocol validation, grant-presence checks, and a method `match` that dispatches filesystem operations.

That shape is adequate for a short-job proof, but not for the intended product model. One Agent controls an interactive, long-lived session through one Gateway. The Engine must keep serving while the Agent owns that session, but must independently prevent abandoned, wedged, or permanently open connections. It must also be possible to add non-filesystem tools without expanding transport or runtime code.

Constraints retained from the existing system:

- One Engine is pinned to one configured Gateway; there is no Gateway discovery, selection, or multi-session concurrency.
- The Gateway remains the Agent-facing control plane and grant issuer. The Engine owns its configured workspace roots and executes tools locally.
- Gateway and Engine remain separate processes. The current local loopback deployment is supported; TLS and remote authentication are separate deployment concerns.
- Workspace containment, descriptor-relative mutation, revision checks, cursors, and resource limits stay in the workspace layer.
- A session is not resumed after a WebSocket disconnect. Its cursors, grants/context, pending requests, and cancellation state are discarded.

## Goals / Non-Goals

**Goals:**

- Define an explicit Engine Runtime state machine with deterministic cleanup and recovery to heartbeat mode.
- Support Agent-controlled open, renewal, and close of one interactive session through the Gateway.
- Bound connection setup, individual operations, idle time, lease lifetime, and continuous connection age.
- Establish a transport-agnostic Dispatcher and a typed, per-file Tool structure.
- Preserve Gateway-first write authorization while making authorization a cross-cutting Engine policy instead of a concern inside each tool.
- Make lifecycle, dispatch, and tool behavior independently testable with fake transports and temporary workspaces.

**Non-Goals:**

- Multiple Gateways, multiple simultaneous Engine sessions, Engine-to-Engine routing, or a dynamic plugin marketplace.
- Persisting session, cursor, grant, request, or in-flight operation state across restart/reconnect.
- A general remote identity, TLS, or signed-capability rollout. The interfaces leave room for it, but this change does not define it.
- Parallel execution of arbitrary tools in the initial implementation. One active session dispatches work serially.
- Replacing the existing workspace containment implementation or adding new filesystem methods.

## Decisions

### 1. Build a single-Gateway Runtime around explicit states

`EngineRuntime` owns one `GatewayConfig`, one transport factory, and the outer lifecycle. Its states are `Boot`, `Heartbeating`, `Waiting`, `Connecting`, `ActiveSession`, `Draining`, `Backoff`, and `Shutdown`. State transitions are explicit events, not nested control flow:

```text
Heartbeating --> Waiting --> Connecting --> ActiveSession --> Draining
      ^              |            |               |              |
      |              |            +--> Backoff ---+              |
      +--------------+------- disconnect / expiry / close --------+
```

While `ActiveSession` is live, ordinary heartbeat polling is suspended. Any transport close, lease expiry, policy timeout, or explicit close enters `Draining`; cleanup is complete before the Runtime resumes heartbeat. There is no reconnect to the old session.

**Why this design:** one explicit owner makes it impossible for a disconnected WebSocket to retain cursors or pending work while the next heartbeat opens another session.

**Alternatives considered:** retain the existing heartbeat loop and call `handle_session` from it (rejected: lifecycle is implicit and cleanup becomes distributed); introduce a general actor/supervisor framework now (rejected: a single configured Gateway and one session do not justify its complexity).

### 2. Use renewable leases for Agent-controlled sessions

The Agent asks the Gateway to open, renew, or close a session. The Gateway mints and tracks the session lease; the Engine enforces the final expiry locally. A lease has a finite `leaseExpiresAt`. An Agent that intends to keep a session open renews it through the Gateway before expiry. Explicit `session.close` remains the normal success path, but expiry is a mandatory safety path.

The Engine applies these independent policies:

- connection timeout: the lease must establish and complete readiness within a bounded period;
- RPC deadline: every request has an Engine-enforced deadline;
- idle timeout: no valid RPC, renewal, or control activity releases the session;
- lease expiry: lack of valid renewal releases the session even if the socket remains open;
- rotation limit: a continuous connection is drained and recreated after a configured maximum age.

Initial policy values are configuration defaults, not client-controlled authority: 15 seconds connection setup, five-minute lease and idle limit, 60-second renewal cadence, 30-second default RPC deadline, and eight-hour rotation. Gateway policy can request stricter values; it cannot weaken Engine hard maxima.

**Why this design:** an Agent controls intent without creating a connection that survives when the Agent or control plane disappears.

**Alternatives considered:** a single hard session duration (rejected: unsuitable for interactive sessions); idle timeout only (rejected: a broken Agent could emit keepalives forever); trusting the Gateway to close abandoned connections (rejected: the Engine needs a local fail-safe).

### 3. Separate control-plane and data-plane messages

The WebSocket carries typed control messages (`session.ready`, `session.renew`, `session.close`, `session.closed`) and data-plane RPC messages (`request`, `response`, `error`). `session.ready` is sent by Engine after local session initialization and reports protocol version, Engine identity/version, configured workspace names, and supported methods. The Gateway MUST NOT send data-plane requests until ready succeeds.

`session.complete` is retained only as a compatibility command during migration and is translated to an Agent-requested close. New Agents use explicit session control.

**Why this design:** lifecycle and business completion become independently observable; a long-lived session no longer abuses a task-completion signal as a lifecycle primitive.

**Alternatives considered:** retain `job.done` as the universal close signal (rejected: it encodes short-job ownership); model control messages as filesystem RPC methods (rejected: conflates runtime control and tool dispatch).

### 4. Pin the session endpoint to Gateway configuration

`GatewayConfig` is the Engine's only upstream authority. The Heartbeat adapter treats a lease endpoint as valid only when its origin matches the configured Gateway origin (or it is a configured relative session path). The Engine does not connect to an arbitrary heartbeat-supplied URL. For loopback development `http://127.0.0.1` maps to `ws://127.0.0.1`; production mapping to TLS is deployment configuration.

**Why this design:** a single-Gateway Engine must not turn a tampered heartbeat response into an outbound connection redirect.

**Alternatives considered:** accept any non-empty `wssUrl` because the token is short-lived (rejected: it widens the trust boundary unnecessarily).

### 5. Use ports/adapters plus a serial Dispatcher and Tool registry

Runtime code depends on narrow transport ports: `HeartbeatTransport` obtains a heartbeat/lease response and `SessionTransport` sends/receives protocol messages. Concrete HTTP and WebSocket adapters implement these ports. `SessionDispatcher` owns envelope validation, session binding, request-id dedupe, deadline/cancellation handling, authorization, execution serialization, and response adaptation.

Tools are registered by canonical method name. Each Tool is a small module with a typed parameter parser, descriptor, and execute function. A descriptor declares method name, read/write access class, default deadline, and execution policy. Initial execution is serial for one session. The registry maps, for example, `fs.read` to `tools/fs/read.rs`; shared workspace safety remains in `workspace` services.

```text
SessionTransport
  --> ProtocolAdapter --> SessionDispatcher --> Authorizer --> ToolRegistry
                                                        --> FsReadTool
                                                        --> FsWriteTool
                                                        --> SessionCloseTool
```

**Why this design:** new tools do not require editing the Runtime or transport loops, while a single serial queue preserves deterministic cursor and mutation behavior.

**Alternatives considered:** one expanding `match` in `engine.rs` (rejected: couples all concerns); dynamic shared-library plugins (rejected: premature security and deployment complexity); fully concurrent dispatch immediately (rejected: cancellation and mutation ordering require a more mature model).

### 6. Canonicalize compatibility calls before authorization and dispatch

The network's canonical data-plane request is a direct method such as `fs.read`. A single-level `tool.call { name, arguments }` is a compatibility adapter: it validates and produces the equivalent canonical invocation before authorization. Nested, malformed, or depth-exhausted `tool.call` is rejected as `INVALID_PARAMS`; no Tool receives `tool.call` as its business method.

**Why this design:** authorization and tool implementations see one method shape, and the legacy wrapper cannot hide a mutation or introduce recursive dispatch.

### 7. Make authorization middleware a boundary, not a tool detail

The Gateway validates issuance, path scope, method scope, and expiry of mutation grants. The Engine's `Authorizer` validates that a write-class Tool invocation arrived on the bound trusted Gateway session with the Gateway-forwarded permission claim. It then supplies an authorized invocation context to the Tool. Workspace containment remains mandatory after authorization.

The current loopback trust boundary permits the Engine to treat an authenticated Gateway session as the assertion source. A future remote deployment can replace this adapter with signed capabilities without changing Tool implementations.

**Why this design:** write policy is consistent across all mutation tools and cannot be bypassed by adding a new tool that forgets an inline check.

### 8. Make session resources and cancellation owned by `SessionContext`

Entering `ActiveSession` constructs `SessionContext`: session id, lease deadline, request-id registry, serial queue, cancellation root, workspace cursor scope, authorization context, and lifecycle telemetry. `Draining` cancels the root, stops new dispatch, emits deterministic errors for queued work, closes the workspace cursor scope, and then closes the transport. Drop/RAII remains the last defence, not the only cleanup path.

## Risks / Trade-offs

- [Lease renewal adds control traffic and clock-sensitive expiry] → Gateway supplies absolute expiry; Engine uses a safety margin and treats uncertain/expired values as close conditions.
- [Serial dispatch can delay later reads behind a slow operation] → enforce per-tool deadlines now; introduce declared read-only concurrency only after metrics demonstrate need.
- [An explicit control protocol is a breaking API change] → retain a bounded compatibility translation for `session.complete`, document migration, and version/control capability-gate it through `session.ready`.
- [Engine-side grant validation is weaker than cryptographic verification in the local model] → pin the Gateway origin, keep the token-bound session, and isolate the Authorizer so signed claims can replace the local assertion later.
- [Forced rotation interrupts a legitimate long-running Agent] → Gateway exposes the reason and automatically obtains a fresh lease; choose a conservative configurable rotation limit.
- [Module splitting increases file count] → use small public interfaces and preserve workspace algorithms as cohesive services rather than scattering them across Tools.

## Migration Plan

1. Add protocol DTOs and Gateway session-control behavior while keeping the legacy short-job fields accepted.
2. Introduce Rust Runtime, transport ports, SessionContext, and Dispatcher behind the existing Engine binary entrypoint; preserve the current loopback invocation and workspace configuration.
3. Move each existing filesystem method into a registered Tool module while retaining the workspace service behavior and its tests.
4. Route Gateway `/session/rpc` through session readiness and the new control/lease model; surface lifecycle events and errors.
5. Enable renewable-session behavior by default; translate legacy `session.complete` to close during a documented compatibility period.
6. Remove the legacy completion lifecycle only after Gateway, Engine, and Agent integration tests use explicit close and renewal.

Rollback is a code rollback to the current short-job Engine and Gateway semantics. No session state is persisted, so there is no data migration. A rollback closes active sessions and Engines resume ordinary heartbeat.

## Open Questions

- Which Agent-facing Gateway endpoints represent open, renew, close, and session status: retained `/session-wanted` plus extensions, or an explicit `/sessions` resource?
- Should a renewal be a Gateway HTTP command only, an Engine WebSocket control message, or both with the Gateway as the sole authority? The recommended model is Agent HTTP to Gateway, then Gateway WebSocket control to Engine.
- What capabilities and version fields must `session.ready` expose before the first Agent integration?
- What telemetry sink and stable Engine identifier should be used outside local development?
