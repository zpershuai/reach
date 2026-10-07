## ADDED Requirements

### Requirement: Shared remote static tool surface
The Gateway HTTP MCP server SHALL reuse connector schemas and filesystem dispatch in process. It SHALL expose static underscore names with required deviceId on filesystem and close tools, and list every registered Engine without a client devices file. Existing stdio names, dynamic behavior, and standalone artifacts SHALL remain compatible.

Remote session_close SHALL report ENGINE_BUSY when this MCP session has no bound client but the Engine remains owned by another caller. It SHALL report success only after closing its own Engine session or confirming that no Engine session exists.

#### Scenario: Remote discovery
- **WHEN** an HTTP MCP client lists tools and devices
- **THEN** it sees static filesystem tools and all Gateway registered Engine ids with last-seen and version information

#### Scenario: Close another caller's Engine
- **WHEN** a remote client without ownership calls session_close on an occupied Engine
- **THEN** the tool returns ENGINE_BUSY and leaves the owner's session intact

### Requirement: Nonblocking remote readiness
Remote pick_device and first filesystem calls SHALL immediately create an owned intent and report connecting with retryAfterMs when not ready. device_status SHALL observe that intent without canceling it. Independent Engine ownership SHALL coexist in one HTTP MCP session.

#### Scenario: Sleeping Engine
- **WHEN** the first remote call targets an idle Engine
- **THEN** it returns promptly and repeated status polls retain the same intent until readiness or cleanup

### Requirement: Remote filesystem safety
Remote filesystem calls MUST retain Gateway canonicalization, grant validation, deduplication, and deadlines. Errors SHALL preserve known Engine codes with human explanations and leave local validation messages intact. Mutation descriptions SHALL instruct callers to read revision, pass ifMatch, and re-read uncertain outcomes before another write. No forwarded mutation SHALL be automatically retried.

#### Scenario: Stale revision
- **WHEN** a remote edit uses an outdated ifMatch
- **THEN** the tool returns REVISION_CONFLICT without changing the file

#### Scenario: Invalid local arguments
- **WHEN** a tool call omits a required filesystem argument
- **THEN** its error preserves the local validation message without describing it as an Engine failure
