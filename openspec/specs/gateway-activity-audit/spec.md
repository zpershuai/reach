# gateway-activity-audit Specification

## Purpose

Records what every ingress client asked every Engine to do, as metadata only, and streams Gateway activity live to the console so the owner can see and review bot actions on private devices.

## Requirements

### Requirement: Structured Gateway events
The Gateway SHALL emit typed events with a monotonically increasing id and timestamp. The event types are: `rpc.started`, `rpc.finished`, `rpc.denied`, `session.state`, `engine.heartbeat`, `client.connected`, `client.disconnected`, `auth.failed` and `admin.action`. Each event names its Engine and ingress client when they are known.

#### Scenario: Forwarded RPC
- **WHEN** a ready session forwards `fs.read` and receives a response
- **THEN** one `rpc.started` and one `rpc.finished` event with the same request id are emitted, the latter with outcome `ok`, latency in milliseconds and response size in bytes

#### Scenario: Engine error
- **WHEN** the Engine replies `FILE_NOT_FOUND`
- **THEN** `rpc.finished` carries outcome `error` and code `FILE_NOT_FOUND`

#### Scenario: Session transition
- **WHEN** an Engine session moves from `wanted` to `connecting` to `ready`
- **THEN** a `session.state` event is emitted for each distinct status with the Engine id and session id

### Requirement: Pipeline stage of a rejection
The Gateway SHALL record where a request was stopped. An authentication failure MUST produce stage `auth`. A missing or non-matching write or process grant MUST produce `rpc.denied` with stage `policy` and the error code. A request that cannot be routed to a ready session MUST produce stage `route`.

#### Scenario: Write without a grant
- **WHEN** a controller sends `fs.write` without a valid grant
- **THEN** the caller receives `PERMISSION_DENIED` and an `rpc.denied` event with stage `policy` is emitted, with no `rpc.started` event and no Engine forward

#### Scenario: No ready session
- **WHEN** `/session/rpc` is called while the Engine has no ready session
- **THEN** an `rpc.denied` event with stage `route` is emitted

### Requirement: Metadata-only audit content
Audit records SHALL contain only the following fields:
- time, request id, Engine id, ingress client label and type;
- method, and for `fs.*` the workspace and path;
- for `process.*` the workspace, script, process id and launch id;
- outcome, code, pipeline stage, latency and response bytes.

Records MUST NOT contain file contents, `content`, `oldString` or `newString`, search patterns, process arguments, process output, tokens or grant ids.

#### Scenario: Write is audited without its body
- **WHEN** a client successfully writes `notes/a.md`
- **THEN** the stored record contains method `fs.write`, workspace and path, and no part of the written content

#### Scenario: Process launch audit
- **WHEN** a client calls `process.run` with arguments
- **THEN** the record contains the script, launch id and resulting process id, and does not contain the arguments

### Requirement: Ingress client attribution
Each event SHALL carry an ingress client label and type:
- `mcp-http`: from the HTTP MCP `initialize` `clientInfo` name and version.
- `controller`: from an optional `X-Reach-Client` header, at most 64 printable characters, defaulting to `Controller API`.
- `engine`: for heartbeats.
- `console`: for administrator actions.

Self-reported labels MUST be marked as unverified.

#### Scenario: Remote MCP client
- **WHEN** an HTTP MCP session initialized with `clientInfo` `{name:"grok-bot", version:"1.2"}` calls `fs_read`
- **THEN** its events carry client type `mcp-http`, label `grok-bot 1.2` and `verified:false`

#### Scenario: Oversized client header
- **WHEN** a controller sends an `X-Reach-Client` header longer than 64 characters or containing control characters
- **THEN** the label falls back to `Controller API` and the request is otherwise processed normally

### Requirement: Live event stream
The Gateway SHALL serve `GET /api/console/events` as `text/event-stream` to signed-in console sessions. It MUST replay buffered events after a `Last-Event-ID` header, from a buffer of at least the latest 1,000 events, and send a heartbeat comment at least every 20 seconds. A slow subscriber MUST be dropped rather than block the data plane.

#### Scenario: Reconnect after a gap
- **WHEN** the console reconnects with `Last-Event-ID: 4180` and events up to 4200 are buffered
- **THEN** events 4181 to 4200 are delivered in order before new events

#### Scenario: Stalled subscriber
- **WHEN** a subscriber's unsent buffer exceeds 1 MiB
- **THEN** the Gateway closes that stream and RPC forwarding latency is unaffected

#### Scenario: Unauthenticated stream
- **WHEN** a request to the event stream has no valid console session
- **THEN** the Gateway returns 401 without streaming

### Requirement: Audit persistence never blocks forwarding
`rpc.finished`, `rpc.denied`, `auth.failed`, `client.*` and `admin.action` events SHALL be persisted to the audit store asynchronously. A storage failure MUST be logged and surfaced as a console health warning. It MUST NOT fail, delay or change any RPC result.

#### Scenario: Disk full
- **WHEN** the audit store cannot be written
- **THEN** RPCs continue with unchanged results and the console Overview shows an audit-storage warning

### Requirement: Activity query
Signed-in sessions SHALL be able to query audit records newest first through a cursor-paginated API. The query MUST accept filters for time range, Engine id, client label, method class (read, write, exec, control) and outcome. It MUST also accept an optional flag that excludes `auth.failed` records; when the flag is absent, `auth.failed` records MUST be included as before.

#### Scenario: Filter by device and failures
- **WHEN** the console requests records for Engine `nas-01` with outcome not `ok`
- **THEN** only that Engine's error and denied records are returned, newest first, with a cursor when more exist

#### Scenario: Exclude authentication failures
- **WHEN** the console requests a page of 50 records with the exclude-authentication-failures flag and the newest 80 stored records are `auth.failed`
- **THEN** the page contains the newest 50 records that are not `auth.failed`, with a cursor when more exist

#### Scenario: Flag absent
- **WHEN** the console requests records without the exclude-authentication-failures flag
- **THEN** `auth.failed` records are returned alongside other records

### Requirement: Audit retention
The Gateway SHALL delete audit records older than the retention period. The period defaults to 30 days, is configurable through `REACH_AUDIT_RETENTION_DAYS` or console settings from 1 to 365 days, and pruning MUST run at least daily.

#### Scenario: Records past retention
- **WHEN** retention is 30 days and a record is 31 days old at the daily prune
- **THEN** the record is deleted

### Requirement: Audit export
Signed-in sessions SHALL be able to export filtered audit records as CSV or JSONL. The export MUST be streamed, MUST use the same filters as the activity query, MUST use a dated filename, and MUST itself be recorded as an `admin.action`.

#### Scenario: CSV export
- **WHEN** the owner exports the last 7 days as CSV
- **THEN** the response is `text/csv` with a header row and one line per record, and an `admin.action` export record is stored
