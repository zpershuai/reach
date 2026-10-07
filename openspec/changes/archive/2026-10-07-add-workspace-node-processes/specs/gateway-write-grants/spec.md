## ADDED Requirements

### Requirement: Separately scoped process grants
Gateway SHALL support a discriminated process grant request alongside the unchanged filesystem grant form. Execution grants MUST bind the active session, target Engine, workspace, exact normalized entry script, launchId and process.run method. Control grants MUST bind active owner session, target Engine, processId and process.stop method. Both SHALL expire after five minutes. Filesystem grants MUST NOT authorize process methods, process grants MUST NOT authorize filesystem mutation, and execution matching MUST NOT use path-prefix scope. MCP grant acquisition SHALL be automatic and MUST NOT be described as human approval.

#### Scenario: Run claim uses a different launch identity
- **WHEN** a grant issued for one launchId is presented on another run
- **THEN** Gateway returns PERMISSION_DENIED without forwarding

#### Scenario: Session changes
- **WHEN** a process grant from a prior session is presented to a new session
- **THEN** Gateway rejects it even if its expiry has not passed

### Requirement: Process authorization on every forwarding path
Gateway MUST validate process grant type, expiry, session, Engine and applicable operation scope before forwarding process.run or process.stop through HTTP or in-process APIs. Canonicalization MUST recognize one tool.call wrapper around process methods, and nested wrappers MUST remain INVALID_PARAMS before authorization. Process observation MUST be routed only through the caller's bound session; Engine SHALL provide final task ownership validation.

#### Scenario: Wrapped run without execution grant
- **WHEN** tool.call wraps process.run without a matching execution grant
- **THEN** Gateway returns PERMISSION_DENIED without forwarding

#### Scenario: In-process control uses forged grant
- **WHEN** in-process forwarding receives process.stop with a fabricated claim
- **THEN** it is rejected by the same grant policy as HTTP forwarding
