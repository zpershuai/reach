## Purpose

Provides Grok Bot with an MCP filesystem surface that is bound to a user-selected Reach Engine device rather than the MCP host filesystem.

## ADDED Requirements

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
