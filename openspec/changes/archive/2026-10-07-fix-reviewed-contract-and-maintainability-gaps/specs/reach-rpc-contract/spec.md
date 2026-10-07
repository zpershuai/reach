## MODIFIED Requirements

### Requirement: Reach RPC request envelope
The system SHALL represent a request as a JSON object with required camelCase fields `type`, `protocol`, `version`, `sessionId`, `requestId`, `method`, and `params`. `type` MUST be `request`, `protocol` MUST be `reach-rpc`, and `version` MUST be `1.0`. `sessionId`, `requestId`, and `method` MUST be non-empty strings and `params` MUST be an object. A request MAY include `permission`, which, when present, MUST be an object with the non-empty string field `grantId`. Permission MAY include `kind`, which MUST be `execute` or `control` when present. On Gateway-to-Engine requests, filesystem writes MUST use a grant without kind; process.run MUST use execute and process.stop MUST use control. The Gateway MUST derive forwarded kind from its validated grant scope rather than trusting a controller-provided kind hint. Mismatched grant classes MUST return `PERMISSION_DENIED` before execution. Implementations MUST ignore unknown envelope and permission object fields; method-specific strict process parameter rules remain applicable. Missing required fields, invalid field types, invalid literal values, empty required strings, or invalid numeric ranges MUST be rejected as `INVALID_PARAMS`.

#### Scenario: Parse a valid fs.read envelope
- **WHEN** a peer receives a request with the required Reach RPC fields and `method` set to `fs.read`
- **THEN** it accepts the envelope as a `reach-rpc` version `1.0` request

#### Scenario: Ignore forward-compatible fields
- **WHEN** a valid request includes an unrecognized envelope or permission field
- **THEN** it accepts the request and omits the unrecognized field when serializing the DTO

#### Scenario: Reject an invalid envelope
- **WHEN** a request omits a required field, has a wrong field type, uses a protocol other than `reach-rpc`, or uses a version other than `1.0`
- **THEN** it rejects the request as `INVALID_PARAMS`

#### Scenario: Reject a mismatched grant class
- **WHEN** a write carries execute/control kind or a process mutation lacks its required kind
- **THEN** authorization returns PERMISSION_DENIED without mutation or process launch


## ADDED Requirements

### Requirement: Shared process wire contract
Rust and TypeScript SHALL expose shared parameter and result DTOs for process.run, process.status, process.logs, process.stop and process.list. Existing execution/MCP modules MUST consume these DTOs while retaining compatible imports. Process parameter parsing MUST reject unknown fields and explicit nulls; defaults, byte bounds, timeout limits, identifiers, selector exclusivity, cursor limits and result nullable fields MUST remain compatible with the existing process contract. Wire DTOs MUST remain usable without launching processes, including non-Unix contract tests. Execution path normalization MUST remain distinct from portable wire serialization and MUST preserve launchId idempotency.

#### Scenario: Default run parameters
- **WHEN** a run request omits args, cwd and timeoutMs
- **THEN** both implementations expose args [], cwd "." and timeoutMs 60000

#### Scenario: Validate requests and results across languages
- **WHEN** shared fixtures cover all five methods, task/log/list results, defaults, Unicode byte limits, nulls, unknown fields and invalid selectors
- **THEN** both implementations agree on acceptance and logical wire payload, with documented execution-only path normalization tested separately

#### Scenario: Invalid process fields remain strict
- **WHEN** a process request includes an unknown field or explicit null parameter
- **THEN** both implementations reject it as INVALID_PARAMS without weakening existing filesystem forward compatibility

