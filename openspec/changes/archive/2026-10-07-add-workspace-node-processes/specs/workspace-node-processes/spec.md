## ADDED Requirements

### Requirement: Fixed-runtime trusted workspace execution
The Engine SHALL execute only trusted `.js`, `.mjs`, or `.cjs` regular entry files from an explicitly execution-enabled workspace using its locally configured private Node executable. The Engine MUST validate real entry and cwd containment, reject symlink traversal and parent escape, and preserve entry identity between validation and launch. It MUST NOT accept shell commands, executable overrides, Node flags, inline eval, caller environment overrides, or package-manager commands. It MUST construct a minimal environment without inherited service tokens, NODE_OPTIONS or NODE_PATH. It MUST return `PROCESS_EXECUTION_DISABLED`, `WORKSPACE_ACCESS_DENIED`, or `RUNTIME_UNAVAILABLE` as applicable without spawning. Entry/cwd validation MUST NOT be represented as isolation of script behavior from the Engine account's OS privileges.

#### Scenario: Launch a workspace script with arguments
- **WHEN** an authorized caller supplies a valid script and string args in an enabled workspace
- **THEN** Engine directly launches its configured Node with those script arguments and validated cwd, without a shell

#### Scenario: Execution is disabled by default
- **WHEN** a caller attempts execution without local workspace opt-in
- **THEN** Engine returns PROCESS_EXECUTION_DISABLED even with a Gateway-issued grant

#### Scenario: Entry escapes or changes identity
- **WHEN** an entry or cwd escapes the workspace, traverses a symlink, or cannot be safely bound to the validated entry
- **THEN** Engine rejects the launch without executing the substituted target

#### Scenario: Runtime is missing
- **WHEN** the configured runtime is not executable
- **THEN** Engine returns RUNTIME_UNAVAILABLE without using a PATH fallback

### Requirement: Asynchronous launch and revision check
`process.run` SHALL accept workspace, script, required non-empty launchId, optional string-array args, cwd, timeoutMs and ifMatch. cwd SHALL default to workspace root; args SHALL default to empty. Timeout SHALL default to 60 seconds and MUST NOT exceed the local ceiling (initially 300 seconds). A successful run MUST promptly return processId, launchId, state, startedAt and deadlineAt without waiting for completion. If supplied, ifMatch MUST match the validated entry bytes under the existing revision algorithm or return REVISION_CONFLICT before spawn. It MUST NOT claim to validate dependency revisions. Process runtime and RPC deadlines MUST remain separate.

#### Scenario: Long task permits observation and stop
- **WHEN** a launched script remains running beyond the RPC budget
- **THEN** run has already returned and later status/logs/stop requests remain dispatchable

#### Scenario: Stale entry revision
- **WHEN** ifMatch differs from the validated entry revision
- **THEN** no process is spawned and REVISION_CONFLICT is returned

### Requirement: Session launch identity and recovery
The Engine MUST reserve launchId before spawn and bind it to the normalized launch payload within its owner session. Reusing that ID with the same payload SHALL return the same launch record without another spawn, except that a cached spawn failure SHALL return its original RUNTIME_UNAVAILABLE error consistently; a different payload MUST return LAUNCH_ID_CONFLICT. Failed and terminal records MUST retain launch identity until session cleanup. `process.status` SHALL accept exactly one of processId or launchId; unknown or foreign identifiers MUST return PROCESS_NOT_FOUND. New requestIds MUST NOT bypass launch deduplication. No automatic run replay or cross-session task adoption SHALL occur.

#### Scenario: Lost response lookup
- **WHEN** a run response is lost but the owner session remains active
- **THEN** status by the original launchId retrieves the existing task without starting another

#### Scenario: Repeated launch after completion
- **WHEN** the same normalized run and launchId are submitted after the task exits in the same session
- **THEN** the original terminal record is returned and no second process starts

#### Scenario: Launch identity conflict
- **WHEN** the same launchId is reused with different args, cwd, script, timeout or revision
- **THEN** LAUNCH_ID_CONFLICT is returned without spawning

### Requirement: Owned process observation
`process.status` SHALL report state, processId, launchId, workspace, script, timestamps and exitCode/signal/reason when known. States SHALL be starting, running, stopping, exited, stopped, timed_out and failed. `process.list` SHALL paginate only the current session's records, optionally filtered by workspace. APIs MUST NOT accept raw OS PIDs or enumerate unrelated host processes. A nonzero script exit SHALL be reported as exited with its exit code, not as a spawn failure.

#### Scenario: Other session attempts observation
- **WHEN** a caller uses another session's processId or launchId
- **THEN** status/logs/stop return PROCESS_NOT_FOUND and list exposes no foreign record

### Requirement: Bounded incremental process output
`process.logs` SHALL accept processId, optional cursor and bounded maxBytes and return ordered stdout/stderr records, nextCursor, truncation/gap information and eof. The Engine MUST continuously drain both pipes even after retention overflow; retained output SHALL default to at most 1 MiB per task and each response to at most 16 KiB. Oldest output MUST be discarded on overflow without blocking the child. Invalid bytes MUST be handled deterministically without crashing; EOF MUST only be reported after both pipes drain. Log cursors MUST be bound to the task and owner session.

#### Scenario: Script floods output
- **WHEN** a script emits more than its retention cap
- **THEN** memory remains bounded, the child pipes continue draining and a lagging logs reader receives explicit truncation information

#### Scenario: Process exits before final pipe drain
- **WHEN** status is terminal but pipe collectors still have output
- **THEN** logs does not report eof until both collectors finish

### Requirement: Idempotent owned process termination
`process.stop` SHALL accept a managed processId and return promptly with the current state. It MUST gracefully terminate the owned process group, escalate after a locally bounded grace period (initially two seconds), reap owned children and retain terminal status. Repeated stop on a retained terminal record MUST succeed without signaling unrelated processes. Timeout MUST use the same cleanup mechanism and report timed_out. Unsupported platforms MUST fail closed rather than silently provide only parent-PID termination. Trusted scripts intentionally escaping process groups are outside the cleanup guarantee and MUST be documented.

#### Scenario: Stop a script with a child
- **WHEN** a script and ordinary descendants remain active and the caller requests stop
- **THEN** the managed process group is terminated and reaped and status converges to stopped

#### Scenario: Stop after exit
- **WHEN** stop is called repeatedly for an already terminal task
- **THEN** the same final record is returned without signaling any new PID

### Requirement: Bounded task admission
Engine SHALL enforce locally configured concurrency, runtime, output and task-record limits. Initial caps SHALL be four running tasks and 128 retained terminal records per session. Admission MUST reject exhausted capacity with PROCESS_LIMIT_EXCEEDED rather than evict launch identities still needed for deduplication. Request parameters MUST NOT raise local maxima.

#### Scenario: Capacity exhausted
- **WHEN** a launch exceeds the concurrency or retained-record capacity
- **THEN** PROCESS_LIMIT_EXCEEDED is returned without spawning and existing task identities remain queryable

#### Scenario: Failed spawn retry
- **WHEN** the fixed runtime cannot spawn and the same launchId and normalized parameters are submitted again
- **THEN** both requests return RUNTIME_UNAVAILABLE without a second spawn attempt, and status reports the retained failed record

#### Scenario: Known failure after request deadline
- **WHEN** entry validation or revision checking fails before launch reservation and the RPC deadline has elapsed
- **THEN** the Engine preserves the known failure code instead of replacing it with an uncertain-launch deadline error
