## MODIFIED Requirements

### Requirement: Device selection gates filesystem tools
In dynamic stdio mode, before a device has been selected, `tools/list` SHALL expose only `list_devices`, `pick_device`, and `get_versions`. `list_devices` SHALL return the connector's configured devices, and `pick_device` SHALL select one configured device, open its Reach Gateway session, wait until the session reports ready, and bind the connector to that device. A failed selection or session open MUST leave filesystem and process tools unavailable.

#### Scenario: Initial tool discovery
- **WHEN** a client calls `tools/list` before picking a device
- **THEN** the result contains `list_devices`, `pick_device`, and `get_versions` and contains no filesystem, process, or session-close tool

#### Scenario: Pick a configured ready device
- **WHEN** a client calls `pick_device` with a configured device identifier and its Gateway reports a ready session
- **THEN** the connector binds that device and reports successful selection

#### Scenario: Reject an unknown or unready device
- **WHEN** a client selects a device identifier that is not configured or whose Gateway does not become ready
- **THEN** the call fails and the connector continues to expose only device-selection and version tools

### Requirement: Tool-list change expands a selected device's surface
After successfully selecting a device, the connector SHALL send MCP `notifications/tools/list_changed`. A subsequent `tools/list` request SHALL expose `fs.read`, `fs.write`, `fs.edit`, `fs.list`, `fs.glob`, `fs.stat`, `fs.grep`, `process.run`, `process.status`, `process.logs`, `process.stop`, `process.list`, and `session.close`; those filesystem and process tool schemas MUST NOT require a `deviceId`, because every invocation is scoped to the selected device.

#### Scenario: Client refreshes after a list-change notification
- **WHEN** a client receives `notifications/tools/list_changed` after a successful device pick and re-fetches `tools/list`
- **THEN** it sees the selected-device filesystem and process tools and `session.close` in addition to device-selection tools

## ADDED Requirements

### Requirement: HTTP close explicitly reports no-op
HTTP session_close SHALL preserve closedDeviceId and SHALL include closed and owned booleans. Closing this MCP client's owned session successfully MUST return closed=true and owned=true. When no Engine session and no local ownership exist it MUST return closed=false and owned=false. A session owned by another client MUST remain untouched and return ENGINE_BUSY. Failed cleanup MUST NOT claim success.

#### Scenario: Close without an active session
- **WHEN** a client calls session_close for a device with no session
- **THEN** it receives closedDeviceId with closed=false and owned=false

#### Scenario: Close an owned session
- **WHEN** the client successfully closes its owned Engine session
- **THEN** it receives closedDeviceId with closed=true and owned=true

#### Scenario: Protect another client's session
- **WHEN** the client has no ownership and another client holds the Engine session
- **THEN** session_close returns ENGINE_BUSY and leaves that session intact

### Requirement: Process guidance and standalone distribution integrity
The plugin SHALL provide process tool guidance covering opt-in execution, execution/control grants, same-session launchId recovery, and termination on session close. Connector builds MUST verify copied core content and MUST produce a standalone distribution whose imports resolve independently of the source workspace.

#### Scenario: Use a process after an uncertain launch
- **WHEN** a remote model consults the plugin process guidance after an uncertain process_run result
- **THEN** it is instructed to query process_status using the same launchId and owned session without replaying the launch or silently replacing the session

#### Scenario: Validate an installed connector layout
- **WHEN** the connector build and distribution checks run
- **THEN** copied core files match the core build and an isolated distribution initializes, lists tools and reports its packaged version

### Requirement: Review fixes have identifiable patch releases
This change SHALL raise Engine from 0.2.0 to 0.2.1 and Gateway/MCP from 0.3.0 to 0.3.1, synchronizing current manifests, lockfiles, version documentation and built artifacts. If intervening versions advance, implementation MUST choose a later patch without downgrade. RPC/MCP protocol and bundled Node runtime versions MUST remain unchanged.

#### Scenario: Verify patched components
- **WHEN** patched artifacts are built
- **THEN** Engine/Gateway/MCP CLI versions, MCP serverInfo/get_versions, Gateway health/status and Engine heartbeat/session.ready report their actual component artifact versions

