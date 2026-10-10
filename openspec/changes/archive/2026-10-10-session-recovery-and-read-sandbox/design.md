## Context

See proposal.md for motivation. Model B remains one loopback Gateway and one Engine session. The Engine still learns that a session is wanted only on its next heartbeat (idle interval 120s); this change does not add an interruptible sleep. Mutations already use `open_verified_parent` + `openat(NOFOLLOW|NONBLOCK)`. Reads and stats still use path-string I/O.

## Goals / Non-Goals

**Goals:**

- Make the default Grok `pick_device` succeed against an Engine that is mid idle-heartbeat, without changing Engine sleep.
- Recover a selected MCP device after Gateway teardown, RPC timeout, or a connecting slot that never becomes ready.
- Give `fs.read` / `fs.stat` the same containment and non-blocking open as writes, with `NOT_UTF8` distinct from absence.

**Non-Goals:**

- Engine heartbeat long-poll or early wake.
- Grant identifiers bound to `sessionId`; remote auth; TLS.
- Rewriting gitignore semantics.
- Descriptor I/O for `fs.list` / `fs.glob` / `fs.grep`.
- Changing `openSession` so connecting sessions can be preempted (open stays 409 while any live WebSocket exists).
- Restoring `sessionWanted` on a failed WebSocket upgrade.

## Decisions

### 1. Cover the 120s idle heartbeat on the MCP client, not the Engine

Default `readyTimeoutMs` becomes 150_000 (120s idle + 15s connect + slack). While Gateway status is `wanted` | `pending` | `connecting`, keep polling. On timeout, best-effort `POST /session/close`.

**Why:** Engine `run()` blocks on `Wait(interval)` with no wake channel. Changing that is a Runtime redesign. The Agent already has a bounded wait; it was just shorter than the heartbeat.

**Alternatives considered:** interruptible Engine sleep (rejected: out of scope); documenting `REACH_MCP_READY_TIMEOUT_MS` as required (rejected: default path stays broken).

### 2. Recover dead sessions in the connector with one retry

`HttpGatewayClient` grows `status()`. Same-id `selectDevice` probes status and only no-ops on `ready`. Reads that see dead-session errors close, reopen once, and retry once. Mutations can do so only before RPC dispatch or on an explicit no-live/ready-session rejection. A dispatched mutation with an ambiguous failure (including `session closed`, `session rpc timeout`, or a transport exception) returns a tool error carrying `RESULT_UNKNOWN` and `mayHaveCommitted: true`, without reopening or replaying that invocation. A later invocation can recover the session normally.

`session already active` during open polls status instead of failing immediately. While status is `closing`, wait for `none` before reopening. A rejected open does not consume the one successful reopen allowance; the overall ready timeout still bounds polling.

**Why:** Gateway already tears down on timeout/idle; the connector was the layer pretending the binding was immortal.

**Alternatives considered:** Gateway auto-reopen (rejected: Agent owns open); unbounded retry (rejected: hides persistent Engine-down).

### 3. Connecting-slot timeout instead of open preempt

Gateway starts a connecting timer on WebSocket `connection`, default 15s (`sessionConnectingMs`, injectable). Valid `session.ready` clears it. Expiry closes the socket with 1008 so `liveSession` drops. `/session/open` remains 409 while `liveSession` is set.

**Why:** Matches Engine `connection_timeout`. Keeps the existing “open rejected while live” contract. MCP close-on-timeout plus this timer together release the slot.

**Alternatives considered:** allow open to preempt a non-ready live session (rejected: races an Engine that is about to send ready); rely only on 5-minute idle (rejected: that is the bug).

### 4. Reuse mutation descriptor opens for read and stat

`read` and `stat` call `open_verified_parent(..., false)` then a byte-returning descriptor open (`NOFOLLOW|NONBLOCK`). UTF-8 decode happens after the open: invalid → `NOT_UTF8`; missing → `FILE_NOT_FOUND`; non-regular → `WORKSPACE_ACCESS_DENIED`. `stat` hashes regular-file bytes only.

**Why:** One containment mechanism. Mutation already solved FIFO and symlink races.

**Alternatives considered:** keep path-string read with extra `symlink_metadata` checks (rejected: TOCTOU); new `NOT_REGULAR_FILE` code (rejected: mutation already uses `WORKSPACE_ACCESS_DENIED`).

## Risks / Trade-offs

- [150s pick wait] → Default Grok pick can block up to 150s when the Engine is down, not only when it is sleeping. Mitigation: status polling still fails at timeout and close-on-timeout clears wanted; operators can lower `REACH_MCP_READY_TIMEOUT_MS`.
- [stdio-proof mock has no `/session/close`] → Close-on-timeout must ignore close failures; mock should accept close as 200 so the proof stays honest.
- [Non-unix read fail-closed] → `read`/`stat` will start denying on non-unix instead of path I/O. Mitigation: production Engine is unix; matches mutation policy.
- [Mutation outcome uncertainty] → A lost reply does not establish that a write was aborted. Do not replay an uncertain dispatched mutation with a new request ID. Return `RESULT_UNKNOWN` so the caller can reconcile the file before deciding on another operation; optional `ifMatch` is not a substitute for this rule.

## Migration Plan

Loopback only; no protocol version bump. Deploy Gateway connecting timer and Engine workspace together with the MCP connector so a long ready wait is not spent on a connecting slot that never dies. Rollback: revert the three packages independently; old connector against new Gateway is safe (just slower to recover); new connector against old Gateway still waits 150s but can remain 409 for 5 minutes on a stuck connecting socket.
