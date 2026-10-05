## Purpose

Provides Grok Bot with an MCP filesystem surface that is bound to a user-selected Reach Engine device rather than the MCP host filesystem.

## Requirements

### Requirement: MCP initialization advertises dynamic tool-list support
The connector SHALL implement MCP initialization over stdio and SHALL return `capabilities.tools.listChanged` as `true`. It MUST NOT require or invoke a native Grok tool-registration API.

#### Scenario: Client initializes the connector
- **WHEN** an MCP client sends a valid `initialize` request
- **THEN** the connector returns MCP server information and declares `capabilities.tools.listChanged` as `true`

### Requirement: Device selection gates filesystem tools
Before a device has been selected, `tools/list` SHALL expose only `list_devices` and `pick_device`. `list_devices` SHALL return the connector's configured devices, and `pick_device` SHALL select one configured device, open its Reach Gateway session, wait until the session reports ready, and bind the connector to that device. A failed selection or session open MUST leave filesystem tools unavailable.

#### Scenario: Initial tool discovery
- **WHEN** a client calls `tools/list` before picking a device
- **THEN** the result contains `list_devices` and `pick_device` and contains no filesystem or session-close tool

#### Scenario: Pick a configured ready device
- **WHEN** a client calls `pick_device` with a configured device identifier and its Gateway reports a ready session
- **THEN** the connector binds that device and reports successful selection

#### Scenario: Reject an unknown or unready device
- **WHEN** a client selects a device identifier that is not configured or whose Gateway does not become ready
- **THEN** the call fails and the connector continues to expose only device-selection tools

### Requirement: Tool-list change expands a selected device's surface
After successfully selecting a device, the connector SHALL send MCP `notifications/tools/list_changed`. A subsequent `tools/list` request SHALL expose `fs.read`, `fs.write`, `fs.edit`, `fs.list`, `fs.glob`, `fs.stat`, `fs.grep`, and `session.close`; those filesystem tool schemas MUST NOT require a `deviceId`, because every invocation is scoped to the selected device.

#### Scenario: Client refreshes after a list-change notification
- **WHEN** a client receives `notifications/tools/list_changed` after a successful device pick and re-fetches `tools/list`
- **THEN** it sees the selected-device filesystem tools and `session.close` in addition to device-selection tools

### Requirement: Gateway-mediated filesystem and lifecycle calls
The connector SHALL use the selected device's Reach Gateway for all session and filesystem work: `POST /session/open`, readiness polling through `POST /session/status`, `POST /session/rpc` for `fs.*`, renewal through `POST /session/renew` as needed, and `POST /session/close` for `session.close`. It MUST return Gateway failures as MCP tool errors and MUST NOT access a host-local workspace or register native Grok tools.

#### Scenario: Read through the selected device Gateway
- **WHEN** a client invokes `fs.read` after selecting a ready device
- **THEN** the connector sends an `fs.read` request to that device's Gateway `/session/rpc` and returns the Engine response as the tool result

#### Scenario: Renew an active session
- **WHEN** an active selected-device lease needs renewal before a filesystem invocation
- **THEN** the connector renews it through that device's Gateway before forwarding the invocation

#### Scenario: Close the selected session
- **WHEN** a client invokes `session.close`
- **THEN** the connector posts to the selected device's Gateway `/session/close` and clears its selected-device session state

### Requirement: Mutation grants remain Gateway-issued
Before forwarding `fs.write` or `fs.edit`, the connector SHALL obtain a grant through the selected device Gateway's `POST /grants` endpoint for the requested workspace, path, and method, and SHALL include the returned grant identifier in the forwarded RPC permission. It MUST NOT manufacture grant identifiers.

#### Scenario: Forward a granted write
- **WHEN** a client invokes `fs.write` for a selected device
- **THEN** the connector requests a matching Gateway grant and forwards the write with that grant identifier

### Requirement: Static compatibility fallback is available and documented
The connector SHALL provide a documented Path 1 mode for MCP hosts that ignore `notifications/tools/list_changed`. In that mode, `tools/list` SHALL expose a static filesystem and session tool surface from startup, and every filesystem and session tool SHALL accept an explicit `deviceId` parameter that identifies one configured device.

#### Scenario: Operator needs a non-refreshing host integration
- **WHEN** an operator uses an MCP host that does not re-fetch `tools/list` after a list-change notification
- **THEN** the documentation identifies how to enable the static `deviceId`-parameter fallback and its trade-off

### Requirement: Bounded readiness and session recovery
The connector MUST default readiness waiting to 150 seconds to cover the Engine's 120-second idle poll and setup. Each HTTP request and response body MUST have a timeout, defaulting to 35 seconds. A failed readiness wait MUST attempt to release its own session intent. Before filesystem calls, the connector MUST verify selected-session readiness and identity and reopen an expired session before forwarding a new RPC. Device switching MUST drain the old session before opening the new one. Renew, close, and RPC MUST carry the bound session id. Stdio EOF MUST close the selected session after received work finishes.

#### Scenario: Idle session has expired
- **WHEN** a filesystem tool is invoked for a previously selected session whose Gateway reports no active session
- **THEN** the connector establishes a new ready session before sending that invocation

#### Scenario: Switch devices
- **WHEN** a client selects another configured device
- **THEN** the connector closes and drains the old selection before opening the new one

### Requirement: Uncertain mutations are never automatically replayed
The connector MUST NOT automatically replay a forwarded RPC after timeout or transport failure. It MUST return the failure as a tool error and remove stale dynamic tools when the selected session is no longer usable.

#### Scenario: Write reply is lost
- **WHEN** an RPC transport fails after the Engine may have committed a write
- **THEN** the connector returns an error and sends no retry of that write

### Requirement: Failure cleanup retains session ownership
On readiness, status, or transport failure, the connector MUST attempt to drain its owned intent. If drain fails, it MUST retain that Gateway client as an uncertain selection, hide its dynamic filesystem tools, and drain it before opening another session. Confirmed ownership loss MUST release only the stale local reference and MUST NOT close the replacement session. A request-scoped deadline error MUST NOT invalidate an otherwise healthy selection. Explicit close and shutdown MAY retry lifecycle cleanup, but MUST NOT replay a forwarded filesystem RPC.

Known pre-forwarding HTTP RPC rejections, including invalid parameters, oversized payloads, duplicate ids, and a full queue, MUST return tool errors without draining a healthy selected session. Uncertain forwarding failures and session-unavailable errors MUST remain eligible for cleanup; HTTP 503 alone MUST NOT imply either category.

#### Scenario: Gateway status and cleanup are temporarily unavailable
- **WHEN** status fails and a best-effort close also fails
- **THEN** the connector retains the uncertain owner, hides dynamic filesystem tools, and a later device pick attempts cleanup before any new open

### Requirement: Legacy Gateway identity acquisition
If `/session/open` returns a session id, the connector MUST bind that acknowledged id before polling and reject any subsequent different id. If a legacy Gateway omits the id from the open reply, the connector MAY adopt the first non-empty id observed during acquisition, then MUST reject later identity changes. Ready status MUST contain a non-empty id. Legacy Gateways without intent binding are supported only under the single-controller assumption.

#### Scenario: Legacy Gateway generates its id at heartbeat
- **WHEN** an open reply and initial wanted status omit the session id, then a ready status exposes the Gateway-generated id
- **THEN** the connector adopts that id and includes it in subsequent RPC, renew, and close requests
