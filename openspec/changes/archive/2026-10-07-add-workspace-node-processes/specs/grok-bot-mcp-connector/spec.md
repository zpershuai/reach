## ADDED Requirements

### Requirement: Shared managed process tools
MCP SHALL expose process.run, process.status, process.logs, process.stop and process.list through common schemas and dispatch. Dynamic stdio SHALL expose dot-named tools after device selection without deviceId; static stdio SHALL require deviceId; HTTP SHALL expose underscore names with required deviceId. Calls MUST use the target Engine through Gateway and MUST NOT execute scripts on the MCP host. Older Engines lacking process methods MUST produce a clear unsupported-capability error without attempted execution. Existing filesystem tool behavior and transports MUST remain compatible.

#### Scenario: HTTP run targets selected remote device
- **WHEN** process_run is called with deviceId and a valid script request on a ready owned session
- **THEN** MCP acquires an execution grant and forwards process.run to that Engine

#### Scenario: Older Engine has no process methods
- **WHEN** the ready Engine's advertised method list omits process.run
- **THEN** a run call returns a clear unsupported-capability error without forwarding a launch

### Requirement: Accurate shared process and filesystem descriptions
Both MCP transports SHALL share process descriptions explaining trusted-code privileges, fixed runtime, workspace-relative entry/cwd, mandatory launchId, asynchronous results, owner-scoped observation, bounded logs and idempotent stop. Running status MUST NOT be described as service readiness. Write/edit descriptions SHALL both explain revision/ifMatch and uncertain-outcome rereads; mode=create guidance MUST appear only on write. Initialization and documentation MUST explain Engine's optional script use of its private runtime rather than state that Engine never executes Node.

#### Scenario: Client inspects tools over either transport
- **WHEN** tools/list returns process and filesystem definitions
- **THEN** descriptions convey the same safety and recovery semantics and fs.edit never instructs callers to provide mode=create

### Requirement: Process launch recovery preserves session identity
MCP MUST NOT automatically replay a forwarded process.run or silently establish a replacement session to look up an old task. Uncertain launch errors MUST preserve launchId and instruct lookup using process.status on the same session. Request-scoped deadlines MUST leave an otherwise healthy session usable. Actual disconnect or ownership loss SHALL follow existing session cleanup semantics and terminate session-owned tasks. Observation calls MUST renew active sessions using existing policy.

#### Scenario: Run result is uncertain but session remains healthy
- **WHEN** a run request times out without transport/session failure
- **THEN** the tool error includes launchId, no automatic retry occurs and status lookup remains possible on the same session

### Requirement: Process release version reporting
The feature release SHALL upgrade Engine from 0.1.0 to 0.2.0 and Gateway/MCP from 0.2.0 to 0.3.0, synchronizing component manifests and lockfiles. Built CLI versions, MCP serverInfo/get_versions, Gateway health/status and Engine heartbeat/session.ready MUST report actual component artifacts. Wire protocol and bundled Node runtime versions MUST remain unchanged. If intervening changes advance versions before implementation, targets MUST be reconciled to a later compatible feature release without downgrading.

#### Scenario: Built release artifacts are inspected
- **WHEN** release verification queries CLI and protocol version reporting paths
- **THEN** each reports its updated component version and protocol/runtime versions remain unchanged
