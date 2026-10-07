## 1. Contracts and platform acceptance

- [x] 1.1 Add matching Rust and TypeScript request/result schemas, state/error definitions and bounded validation for five process methods, launch identity, logs and list pagination.
- [x] 1.2 Verify a safe entry-snapshot bootstrap launch mechanism using the private Node runtime for CJS, ESM, sibling imports and script argv on supported Unix platforms; document explicit unsupported-target behavior without weakening entry validation.
- [x] 1.3 Verify owned process-group termination, grace escalation and child reaping on supported targets; document the intentionally detached-descendant limitation.

## 2. Local policy and execution authorization

- [x] 2.1 Add validated Engine-local workspace execution opt-in, fixed runtime path and process limits with execution disabled by default; preserve existing configuration compatibility.
- [x] 2.2 Extend Gateway grant storage and issuance with process execution/control variants scoped to session, Engine and operation identity, preserving existing filesystem grants.
- [x] 2.3 Extend Gateway canonicalization and HTTP/in-process dispatch checks for process.run/process.stop, including single-level tool.call and nested-call rejection.
- [x] 2.4 Add Execute/ProcessControl Tool access and structured invocation authorization; enforce local workspace policy and session task ownership independently of Gateway claims.
- [x] 2.5 Verify forged, expired, wrong-session, wrong-device, wrong-script, wrong-launchId and wrong-process grants, cross-type grant rejection, and local denial with a valid grant.

## 3. ProcessManager and Engine tools

- [x] 3.1 Implement session-owned task registry, required launchId reservation, normalized-payload deduplication/conflicts and bounded record admission without launch identity eviction.
- [x] 3.2 Implement direct private-Node spawn with validated entry/cwd, optional entry revision check, sanitized environment, string argv and no executable/Node-flag/env override surface.
- [x] 3.3 Implement background stdout/stderr collection with bounded retention, incremental cursors, explicit truncation, deterministic byte decoding and final pipe-drain EOF.
- [x] 3.4 Implement state observation and paginated owner-only list; return PROCESS_NOT_FOUND for unknown/foreign identifiers and preserve terminal records.
- [x] 3.5 Implement idempotent asynchronous stop and independent task timeouts with graceful/forced group termination and reaping.
- [x] 3.6 Register all five short-lived handlers and ProcessManager in InvocationContext; preserve successful spawn commit results without blocking serial requests behind script lifetime.
- [x] 3.7 Verify duplicate launch after exit, changed-payload conflicts, stale revisions, missing runtime, path/symlink rejection, environment filtering, nonzero exit, invalid UTF-8 and output/task capacity limits.

## 4. Session lifecycle integration

- [x] 4.1 Drain process resources on close, disconnect, lease expiry, rotation, shutdown and failure before session release/heartbeat; expose cleanup failures and prevent premature replacement sessions.
- [x] 4.2 Count live tasks as idle activity while keeping lease and rotation ceilings effective; restart idle window on completion and prevent tasks renewing their own lease.
- [x] 4.3 Verify status/stop responsiveness during long tasks, all cleanup paths, no cross-session adoption, and no signal to unrelated reused PIDs after terminal stop.

## 5. MCP surfaces and recovery

- [x] 5.1 Add shared process tool definitions, schemas, dispatch and grant acquisition for dynamic/static stdio and underscore HTTP modes with existing device routing semantics.
- [x] 5.2 Preserve launchId in uncertain errors, support status lookup without replacement-session acquisition, renew healthy sessions, and never automatically replay forwarded launches.
- [x] 5.3 Check advertised Engine methods for unsupported process capability and preserve clear local/Engine errors without breaking old filesystem-only clients.
- [x] 5.4 Share accurate process descriptions and instructions across transports; unify filesystem revision/timeout guidance and restrict mode=create guidance to fs.write.
- [x] 5.5 Verify all MCP modes, ownership isolation across clients/devices, unsupported old Engines, lost-response lookup and request-deadline behavior.

## 6. Documentation and component releases

- [x] 6.1 Update Engine/runtime/MCP deployment docs, READMEs, initialization text and affected assertions to explain optional trusted Node script execution, local opt-in, session lifetime, limits and recovery using generic examples only.
- [x] 6.2 Upgrade Engine to 0.2.0 and Gateway/MCP to 0.3.0 in manifests and lockfiles, reconciling any intervening version advances; keep protocol and bundled runtime versions unchanged.
- [x] 6.3 Correct stale current-version documentation and build Engine, Gateway and standalone MCP artifacts; verify CLI, serverInfo/get_versions, health/status and heartbeat/session.ready version reporting.

## 7. End-to-end validation

- [x] 7.1 Run focused Rust/TypeScript process, authorization and lifecycle checks, existing filesystem regression tests, package builds and repository-required verification (`bash scripts/verify.sh`).
- [x] 7.2 Add and run a local integration scenario through Gateway and both MCP transports: write script, run, inspect status/logs, stop, launch again with a new launchId, then close and verify cleanup.
- [x] 7.3 Verify no Engine process launches on the MCP host, no script secrets appear in version/log metadata, and no installed service/configuration is modified by implementation verification.
- [x] 7.4 Validate the completed change artifacts against the implementation and record concrete platform support and any unavailable target verification before marking tasks complete.
