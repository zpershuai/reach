# edge-engine-service Specification

## Purpose

Defines the long-running Reach Engine agent that heartbeats to a Gateway, accepts issued sessions, executes workspace filesystem RPC on the Engine host, and signals job completion.

## Requirements

### Requirement: Resident engine heartbeat loop
The Engine SHALL run as a long-lived process that repeatedly POSTs device information to the Gateway `/heartbeat` endpoint, waits `intervalSeconds` from each successful response before the next heartbeat, and continues this loop until the process is stopped. When a heartbeat response includes `wssUrl` and `token`, the Engine MUST attempt to open a session before continuing ordinary idle polling. The Engine MUST treat missing session fields as “no work” and keep heartbeating at the returned interval.

#### Scenario: Idle polling continues
- **WHEN** the Engine receives a heartbeat response with `intervalSeconds` 120 and no session credentials
- **THEN** it waits 120 seconds and POSTs another heartbeat without opening a WebSocket

#### Scenario: Session credentials trigger a connect
- **WHEN** the Engine receives a heartbeat response that includes `wssUrl` and `token` while no session is already open
- **THEN** it opens a WebSocket to that URL with the issued token and does not wait for a separate operator command to connect

### Requirement: Engine-owned workspace execution
The Engine SHALL execute `fs.*` and `tool.call` filesystem methods against its own configured workspace root map. The default `default` workspace MUST map to `~/.reach/workspace` on the Engine host unless overridden at Engine startup. The Engine MUST reject unknown workspace names with `WORKSPACE_ACCESS_DENIED` and MUST apply the same containment, revision, mutation, search, and cursor rules defined by `workspace-filesystem-rpc`.

#### Scenario: Read uses the engine workspace
- **WHEN** a live session delivers a valid `fs.read` for workspace `default`
- **THEN** the Engine reads from its configured `default` root and returns the file result without requiring a Gateway-local filesystem

#### Scenario: Unknown workspace is denied on the engine
- **WHEN** a request names a workspace absent from the Engine root map
- **THEN** the Engine returns `WORKSPACE_ACCESS_DENIED` and does not touch the host filesystem outside configured roots

### Requirement: Session RPC handler role
While a session WebSocket is open, the Engine SHALL accept `reach-rpc/1.0` request envelopes originating from the Gateway, bind them to the session’s `sessionId`, dispatch supported filesystem methods, and reply with `response` or `error` messages that echo `requestId`. The Engine MUST NOT send filesystem `request` envelopes to the Gateway. Nested `tool.call` MUST be rejected with `INVALID_PARAMS` and MUST NOT recurse. After the Gateway indicates the job is finished or the Engine completes the assigned stub/integration job path, the Engine SHALL send `job.done` and expect the Gateway to close the socket. On every session exit path—including clean `job.done`, peer close, read failure, or response send failure—the Engine MUST clear all workspace pagination cursors for that session before accepting another session.

#### Scenario: Engine answers a gateway filesystem request
- **WHEN** the Gateway sends a complete `fs.list` request envelope on the live session
- **THEN** the Engine returns a `response` with the same `requestId` and list result from its local workspace

#### Scenario: Engine does not request gateway files
- **WHEN** a session is live
- **THEN** the Engine performs filesystem work only by handling inbound requests and does not emit outbound `type=request` filesystem calls to the Gateway

#### Scenario: Engine rejects nested tool.call
- **WHEN** the Gateway forwards (or a test injects) `tool.call` whose `name` is `tool.call`
- **THEN** the Engine returns `INVALID_PARAMS` and does not dispatch nested work

#### Scenario: Abnormal disconnect clears session cursors
- **WHEN** the session WebSocket read or response send fails after the Engine has issued pagination cursors
- **THEN** those cursors are cleared and a subsequent session cannot resume them

#### Scenario: Engine denies a special-file mutation target without blocking
- **WHEN** a forwarded `fs.write`/`fs.edit` targets a FIFO or device node in a workspace
- **THEN** the Engine returns `WORKSPACE_ACCESS_DENIED` promptly and continues serving the session without stalling, because a blocking open of a non-regular target would otherwise hang the single-threaded session loop

### Requirement: Engine startup configuration
The Engine SHALL accept a Gateway base URL (default `http://127.0.0.1:8787`) and optional workspace root map overrides at process start. It MUST fail fast on an invalid Gateway URL scheme for the supported local HTTP proof path used in this change.

#### Scenario: Default local gateway target
- **WHEN** the Engine starts with no Gateway URL override
- **THEN** it heartbeats to `http://127.0.0.1:8787`
