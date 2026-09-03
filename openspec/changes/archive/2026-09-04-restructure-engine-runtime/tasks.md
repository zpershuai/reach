## 1. Protocol and configuration foundation

- [x] 1.1 Define Rust and TypeScript DTOs for `session.ready`, `session.renew`, `session.close`, and `session.closed`, including validation and cross-language fixtures.
- [x] 1.2 Define the Agent-facing Gateway session-control API for open, renew, status, and close, including status/error responses and ownership rules.
- [x] 1.3 Add Engine configuration parsing and validation for one Gateway origin, Engine identifier, workspace roots, and bounded Runtime timeout policy.
- [x] 1.4 Add endpoint-origin validation that accepts only Gateway-relative or Gateway-origin session endpoints.
- [x] 1.5 Document the compatibility treatment and eventual deprecation of `session.complete` and `job.done` short-job lifecycle semantics.

## 2. Gateway lease and session control

- [x] 2.1 Evolve `/heartbeat` to issue a bounded session lease with stable token, session id, endpoint, and absolute expiry while a session is pending.
- [x] 2.2 Implement Agent open, renewal, status, and close controls in the Gateway without allowing more than one active Engine session.
- [x] 2.3 Require Engine `session.ready` before Gateway forwards `/session/rpc` data-plane requests.
- [x] 2.4 Relay valid renew and close controls to the bound Engine WebSocket and expose Engine closure reasons to the Agent.
- [x] 2.5 Reject or fail new RPC consistently while a session is not ready, draining, expired, or closed.
- [x] 2.6 Extend Gateway tests for ready gating, renewable lease expiry, explicit close, Engine policy closure, endpoint pinning, and legacy compatibility.

## 3. Engine Runtime and transport ports

- [x] 3.1 Create Runtime state, event, policy, and Gateway configuration modules without changing filesystem behavior.
- [x] 3.2 Define heartbeat and session transport ports plus concrete local HTTP/WebSocket adapters.
- [x] 3.3 Implement the single-Gateway Runtime transition loop for heartbeat, waiting, connecting, active session, draining, backoff, and shutdown.
- [x] 3.4 Implement connection timeout, lease expiry, idle timeout, rotation, and safe backoff behavior.
- [x] 3.5 Create `SessionContext` with cancellation root, request identity registry, queue, cursor lifecycle, authorization context, and teardown hooks.
- [x] 3.6 Add Runtime unit tests using fake transports for normal open/close, disconnect recovery, endpoint rejection, lease expiry, idle closure, and rotation.

## 4. Dispatcher, authorization, and Tool structure

- [x] 4.1 Define the SessionDispatcher request pipeline, canonical invocation type, error mapping, request-id deduplication, and serial execution queue.
- [x] 4.2 Define the Tool descriptor and registry interfaces for method metadata, typed parameter validation, access class, deadline, and execution.
- [x] 4.3 Implement authorization middleware that supplies an authorized invocation context for write-class Tools and preserves Gateway-first grant validation.
- [x] 4.4 Implement the one-level `tool.call` compatibility adapter before authorization and registry lookup; reject nested or malformed wrappers.
- [x] 4.5 Add Dispatcher tests for validation, session binding, duplicate request ids, deadline/cancellation, authorization denial, queue draining, and compatibility canonicalization.

## 5. Filesystem Tool extraction

- [x] 5.1 Split current `fs.read`, `fs.list`, and `fs.stat` handling into independently registered Tool modules backed by shared workspace services.
- [x] 5.2 Split current `fs.write` and `fs.edit` handling into write-class Tool modules with authorized invocation context and existing atomic mutation guarantees.
- [x] 5.3 Split current `fs.glob` and `fs.grep` handling into registered Tool modules while retaining bounded traversal and session cursor behavior.
- [x] 5.4 Move cursor cleanup ownership from the monolithic session loop into `SessionContext` and verify cursors invalidate on every Runtime exit path.
- [x] 5.5 Add focused Tool tests proving workspace containment, revision behavior, error mapping, and no execution of queued work after drain.

## 6. Observability and integration verification

- [x] 6.1 Emit structured lifecycle events for Runtime transitions, heartbeat outcomes, session readiness/closure, lease expiry, RPC disposition, authorization denial, and Tool execution.
- [x] 6.2 Add Gateway/Engine integration tests for Agent open -> ready -> RPC -> renew -> close.
- [x] 6.3 Add integration tests for abandoned Agent lease, idle timeout, RPC timeout, WebSocket failure, rotation, and clean heartbeat recovery.
- [x] 6.4 Run Rust formatting, unit tests, and integration tests; run TypeScript build and test suites; fix regressions.
- [x] 6.5 Update README operational instructions with Engine configuration, Agent session lifecycle, timeout defaults, closure reasons, and migration from short-job completion.

## 7. Review remediation

- [x] 7.1 Enforce a real Engine-side RPC deadline across dispatcher and cooperative filesystem traversal, with focused timeout tests.
- [x] 7.2 Reject renewal while a Gateway session is draining or closed and safely handle control-message send failures.
- [x] 7.3 Fail fast for unsupported HTTPS/WSS configuration in the loopback-only transport instead of attempting plaintext TCP.
- [x] 7.4 Make the Gateway oversized-frame lifecycle test wait for server-side session teardown, then run the Rust and TypeScript suites cleanly.
