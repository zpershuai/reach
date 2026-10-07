## Context

Engine currently dispatches serial filesystem Tools through a session-bound invocation context. Gateway validates scoped filesystem grants; Engine checks a forwarded claim and enforces workspace containment. Installers already provision the private runtime selected by `scripts/node-runtime.json`, but Engine does not execute Node. RPC has a hard execution bound, and session drop currently releases workspace state only.

This cross-component change introduces trusted code execution. A workspace-relative entry point and cwd do not sandbox Node: code runs with the Engine account's OS privileges. The accepted first-release scope is trusted scripts with session-owned lifetime.

## Goals / Non-Goals

**Goals:** Run workspace Node scripts asynchronously on the selected Engine; inspect state and bounded output; stop owned work; enforce local opt-in, limits, execution grants, launch identity, and cleanup; expose identical semantics over both MCP transports; publish accurate component versions.

**Non-Goals:** Shell commands, caller-selected executables/Node flags, inline eval, interactive stdin, npm/npx execution, automatic dependency installation, hostile-code isolation, persistent services, automatic restarts, cross-session task adoption, or changes to running installations.

## Decisions

### 1. Fixed runtime and local opt-in

Add Engine-owned process policy with an explicit workspace allowlist (default empty), absolute Node binary path (default `~/.reach/runtime/node/bin/node`, expanded by Engine), concurrency cap, maximum runtime, output retention and task-record caps. Validate policy at startup; missing runtime produces `RUNTIME_UNAVAILABLE` when execution is attempted and never falls back to PATH. Runtime overrides are operator configuration, never RPC parameters. Existing launcher configuration remains independent.

Initial defaults: maximum 4 running processes per Engine, run timeout 60 seconds, local timeout ceiling 300 seconds, 1 MiB retained output per task, 128 retained terminal task records, 16 KiB per logs response, 2-second graceful-stop period. Reaching retained-record capacity rejects new launches with `PROCESS_LIMIT_EXCEEDED`; it does not evict launch identities during the session. All limits have validated local configuration; requests can only lower permitted bounds.

Use direct Rust process spawn with argv; no launcher shell. Set cwd to a validated real workspace directory. Accept only `.js`, `.mjs`, `.cjs` regular entry files. Resolve entry and cwd inside the real workspace, reject links in entry/cwd traversal, and reject escape paths before spawn. Entry validation is not isolation of imported modules or filesystem access inside the script. Read the validated entry through a held no-follow descriptor into a bounded snapshot. An Engine-embedded Node bootstrap receives that snapshot over stdin, installs synchronous module hooks and uses Node runMain with its original absolute module URL and Engine-owned --preserve-symlinks-main. This preserves require.main/import.meta.main while preventing symlink substitution from changing the entry identity. This preserves entry bytes and relative imports without executing /dev/fd as the module identity. Internal bootstrap code/flags are Engine-owned; callers still cannot supply eval or runtime flags. Verify CJS/ESM, package type, sibling imports and argv on supported targets; fail closed on unsupported platforms.

Clear the inherited environment and construct a documented minimal environment (PATH rooted at the private runtime and approved system locations, required platform variables, workspace-based HOME/temp policy). Do not inherit Controller/Engine tokens, NODE_OPTIONS or NODE_PATH. No caller-supplied env in the first release. This reduces accidental disclosure and runtime injection but does not prevent trusted code from reading resources available to its OS account.

Alternative: arbitrary shell interface would broaden both permissions and platform behavior. Alternative: a code sandbox is a separate product and platform project.

### 2. Asynchronous task contract

`process.run` accepts `{workspace, script, args?: string[], cwd?: string, timeoutMs?: integer, ifMatch?: revision, launchId: string}`. Defaults: args empty, cwd workspace root, timeout 60 seconds capped by local policy. `ifMatch` verifies the held entry file bytes using the existing revision algorithm, not the dependency tree. A successful launch returns `{processId, launchId, state, startedAt, deadlineAt}` promptly; it never waits for script completion.

`process.status` accepts exactly one of `processId` or `launchId`. `process.stop` accepts processId. `process.logs` accepts processId, optional cursor and maxBytes (bounded by policy). `process.list` accepts optional workspace and a bounded pagination cursor. All requests resolve against the active session; no raw PID input or all-host process enumeration.

Task state is `starting`, `running`, `stopping`, `exited`, `stopped`, `timed_out`, or `failed`. Records include owner session, workspace, validated script, timestamps, exitCode/signal when available, and reason. Terminal records and launch identities remain until session cleanup, subject to admission caps. An immediate nonzero script exit is `exited` with its code; pre-spawn failures are `failed` when a launch record has been reserved.

Reserve launchId before spawn. Identical normalized requests with the same launchId in the same session return the same record, including a terminal record; different payloads return `LAUNCH_ID_CONFLICT`. Use fresh requestIds for lookups; launchId is the longer-lived execution identity. status by launchId is the recovery path after a lost run response. No automatic replay after uncertain forwarding or session replacement.

### 3. ProcessManager owns execution resources

Add a ProcessManager reachable through InvocationContext, with session-scoped task registries and OS handles. Tools remain short serial operations; worker threads handle pipe draining, exit observation and deadlines. Process runtime deadlines are independent of RPC deadlines. A run commit is the registered successful spawn: preserve its successful response if an RPC deadline elapses afterward, as with filesystem mutation commits; report launchId on uncertain MCP errors.

Drain stdout/stderr continuously into one bounded stream of records with sequence cursor and stream label. Decode arbitrary bytes with replacement and handle partial UTF-8 consistently. Drop oldest output on overflow, continue draining, and report cursor gaps/truncation explicitly. EOF is true only when both pipes have drained after exit. Logs never use unbounded in-memory strings or block behind a long run. Limit request argument sizes and record metadata within existing envelope/body bounds.

Stop is idempotent for retained terminal records. Use an owned process group on supported Unix targets, request graceful termination, escalate after the local grace period, reap children, then report terminal status. Returning `stopping` promptly permits responsive polling. Fail closed when process-tree lifecycle support is unavailable; do not advertise supported execution there. Detached descendants deliberately escaping process groups are outside trusted-script guarantees; document this rather than promise hostile-process containment.

### 4. Explicit execution and control grants

Extend the grant API with a discriminated process form while preserving the existing filesystem request/response. Run grants bind active session, target Engine (explicitly or by its per-Engine store), workspace, exact normalized script, launchId and `process.run`. Control grants bind owner session, target Engine, processId and `process.stop`. Five-minute expiry remains. Grant matching must reject a filesystem grant on process operations and reject a process grant on filesystem writes. Do not reuse path-prefix semantics for execution. Status/logs/list require session ownership but no mutation grant.

Gateway canonicalization must recognize sensitive process methods, including one-level tool.call; nested tool.call remains rejected before authorization. Both HTTP and in-process forwarding enforce the same checks. MCP automatically acquires process grants as it currently acquires write grants; this is not a human approval flow.

Engine adds Execute and ProcessControl access classes and carries structured authorization context to handlers. It remains pinned to a trusted Gateway for grant validity, but independently checks workspace opt-in, ownership, selected runtime, limits, and path validation. Gateway claims cannot enable a locally disabled workspace. Avoid using the filesystem write_claimed boolean to imply execution authority.

### 5. Session lifetime is the ownership boundary

Close, lease expiry, disconnect, rotation, shutdown and failure paths reject new launches and stop/reap owned tasks before resources are released or heartbeat resumes. Background managed work counts as activity for idle detection; lease expiry and rotation remain hard bounds. MCP polling renews leases under the existing policy; an unattended task cannot renew itself. On task completion, restart the idle window. No task or logs resume in a new session, and no automatic new session is opened just to recover a previous processId.

Bound cleanup waits with graceful/forced termination and report lifecycle cleanup failures; do not report successful draining or establish a replacement session while owned resources remain unresolved. Abrupt OS kill of Engine is outside graceful-cleanup guarantees; no reboot persistence is offered.

Alternative: Engine-lifetime daemon tasks need durable ownership, reconnection and restart semantics and are deferred.

### 6. MCP discovery and descriptions

Share definitions and typed dispatch for five process tools. Dynamic stdio adds dot-named tools after selection; static stdio requires deviceId; HTTP exposes underscore names with deviceId. Static surfaces may expose schemas before device readiness; call results must clearly identify unsupported methods/disabled execution. Use reported session methods to detect older Engines and avoid forwarding unsupported operations.

run descriptions explain trusted code privileges, fixed runtime, workspace-relative entry, asynchronous completion and mandatory launchId. status supports recovery by launchId; running does not mean service-ready. logs explains cursors and truncation. stop explains ownership and idempotence. list describes session-only visibility. Errors preserve known Engine codes and local argument explanations. Uncertain run errors preserve launchId and instruct a status lookup on the same session, with no retry or lifecycle cleanup merely for a request-scoped deadline. Actual disconnect still follows existing drain behavior and terminates tasks.

Update shared filesystem write/edit descriptions while touching the common definitions: revision/ifMatch and timeout recovery guidance for both transports; mode=create guidance belongs only to write. Replace obsolete claims that Engine never executes Node in initialization, README, runtime and installation docs, and affected assertions.

### 7. Versions and compatibility

Baseline manifests are Engine 0.1.0, Gateway 0.2.0, MCP 0.2.0. Target minor releases are Engine 0.2.0 and Gateway/MCP 0.3.0. Update Cargo/npm lockfiles and verify built CLI versions, MCP serverInfo/get_versions, Gateway health/status and Engine heartbeat/session.ready. Correct stale documentation saying all components are 0.1.0. Keep reach-rpc/1.0, negotiated MCP protocol versions and scripts/node-runtime.json unchanged. Old filesystem clients continue working; old Engines return unsupported process capability clearly. If manifests change before apply, reconcile target versions rather than downgrade them.

## Risks / Trade-offs

- [Trusted scripts can access account resources] -> Explicit local enablement and honest descriptions; no sandbox claim.
- [Snapshot bootstrap execution can affect ESM/import resolution] -> Verify CJS, ESM, sibling imports and argv on macOS/Linux/OpenWrt before accepting the launch implementation; unsupported targets fail closed.
- [Lost launch replies duplicate side effects] -> Required launchId, payload conflict detection and status lookup; no automatic replay.
- [Output or task spam exhausts memory] -> Bounded pipes, buffers, metadata and admission limits; preserve launch identities until session ends.
- [Serial dispatch or cleanup blocks stop] -> Short Tool handlers, background process ownership and bounded graceful/forced cleanup.
- [Process groups cannot contain intentionally detached descendants] -> Trusted-code scope and explicit documented limitation.

## Migration Plan

Implement additive contracts and tests, integrate Engine/Gateway/MCP, update docs and component versions, then build and verify standalone artifacts. Installation examples use reserved domains and generic device IDs. Do not enable execution or restart installed services automatically. Operators enable selected workspace execution explicitly after installing matching artifacts. Rollback first drains processes, disables execution and restores earlier artifacts; existing filesystem configuration remains valid.

## Open Questions

Record target verification in ignored .reach/ files; explicitly identify unavailable targets and use the portable tests in the existing Linux/macOS CI matrix. No unresolved product-scope questions: trusted execution and session ownership follow the requested analysis. Snapshot bootstrap Node module behavior and platform process-tree cleanup are implementation acceptance gates, not permission to weaken the contract. Unsupported platform behavior must be explicit and tested.

Review refinements: Preserve known execution errors after an RPC deadline, including failures before launch reservation. A failed spawn retains a failed status record and returns RUNTIME_UNAVAILABLE consistently on duplicate launches. Uncertain callers first query status; PROCESS_NOT_FOUND permits a manual retry with the identical launchId and parameters. Cleanup failure retains ownership during normal operation; SIGTERM permits bounded shutdown with PROCESS_CLEANUP_FAILED and no successful session-release event. Natural leader exit also cleans ordinary group descendants.
