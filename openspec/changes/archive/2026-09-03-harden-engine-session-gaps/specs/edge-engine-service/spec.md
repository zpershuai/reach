## MODIFIED Requirements

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
