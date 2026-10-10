## Purpose

Defines the portable Reach RPC wire contract for filesystem and trusted process requests between Rust and TypeScript peers.

## Requirements

### Requirement: Reach RPC request envelope
The system SHALL represent a request as a JSON object with required camelCase fields `type`, `protocol`, `version`, `sessionId`, `requestId`, `method`, and `params`.

#### Scenario: Required reach rpc request envelope behavior
- **WHEN** a protocol message is serialized or validated
- **THEN** `type` MUST be `request`, `protocol` MUST be `reach-rpc`, and `version` MUST be `1.0`.
- **AND** `sessionId`, `requestId`, and `method` MUST be non-empty strings and `params` MUST be an object.
- **AND** A request MAY include `permission`, which, when present, MUST be an object with the non-empty string field `grantId`.
- **AND** Permission MAY include `kind`, which MUST be `execute` or `control` when present.
- **AND** On Gateway-to-Engine requests, filesystem writes MUST use a grant without kind; process.run MUST use execute and process.stop MUST use control.
- **AND** The Gateway MUST derive forwarded kind from its validated grant scope rather than trusting a controller-provided kind hint.
- **AND** Mismatched grant classes MUST return `PERMISSION_DENIED` before execution.
- **AND** Implementations MUST ignore unknown envelope and permission object fields; method-specific strict process parameter rules remain applicable.
- **AND** Missing required fields, invalid field types, invalid literal values, empty required strings, or invalid numeric ranges MUST be rejected as `INVALID_PARAMS`.

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

### Requirement: fs.read parameters
The system SHALL define `fs.read` parameters as a JSON object containing non-empty string fields `workspace` and `path`, plus integer `startLine` and `maxLines`. `startLine` MUST be at least 1 and defaults to 1 when omitted. `maxLines` MUST be between 1 and 10,000 inclusive and defaults to 200 when omitted. Implementations MUST reject invalid parameter field types, empty strings, non-integers, and out-of-range integers as `INVALID_PARAMS`. Implementations MUST ignore unknown parameter fields.

#### Scenario: Apply fs.read defaults
- **WHEN** a valid `fs.read` request omits `startLine` and `maxLines`
- **THEN** the parsed and serialized parameters contain `startLine` 1 and `maxLines` 200

#### Scenario: Reject invalid fs.read range
- **WHEN** an `fs.read` request supplies `startLine` 0 or `maxLines` greater than 10,000
- **THEN** it rejects the request as `INVALID_PARAMS`

### Requirement: fs.read result
The system SHALL represent an `fs.read` result as a JSON object containing string `content`, integer `startLine`, integer `endLine`, integer `totalLines`, boolean `truncated`, and string `revision`.

#### Scenario: Required fs.read result behavior
- **WHEN** a protocol message is serialized or validated
- **THEN** `startLine` MUST be at least 1, `endLine` MUST be at least `startLine - 1`, and `totalLines` MUST be non-negative.
- **AND** `revision` MUST be the lowercase hexadecimal SHA-256 digest of the complete file content and is otherwise opaque to clients.
- **AND** The result MUST be serializable with camelCase property names.

#### Scenario: Represent a truncated file read
- **WHEN** a file read returns fewer lines than the file contains due to its requested limit
- **THEN** the result contains the returned line range, total line count, `truncated` true, and the complete-content revision

### Requirement: Cross-language fixture compatibility
The system SHALL provide a canonical JSON fixture for a valid `fs.read` request. Rust and TypeScript contract implementations MUST each parse and serialize this fixture, producing the same logical payload with defaulted values and without unknown fields.

#### Scenario: Round-trip the fixture in both implementations
- **WHEN** the Round 1 fixture validation is run
- **THEN** both Rust Serde and TypeScript Zod parse and serialize the request successfully with equivalent logical payloads

### Requirement: Round 4 filesystem DTO compatibility
The system SHALL represent parameters and results for `fs.write`, `fs.edit`, `fs.list`, `fs.glob`, `fs.stat`, and `fs.grep` using camelCase JSON fields. Rust Serde and TypeScript Zod implementations MUST reject invalid parameters as `INVALID_PARAMS` and ignore unknown object fields.

#### Scenario: Match filesystem DTO parsing across languages
- **WHEN** Rust and TypeScript parse the same valid Round 4 filesystem request with unknown fields
- **THEN** each produces an equivalent logical payload with defaults applied and unknown fields omitted

### Requirement: Session control message contract
The system SHALL represent Engine session control separately from data-plane request envelopes.

#### Scenario: Required session control message contract behavior
- **WHEN** a protocol message is serialized or validated
- **THEN** Supported control message types are `session.ready`, `session.renew`, `session.close`, and `session.closed`; each MUST contain a non-empty `sessionId`.
- **AND** `session.renew` MUST include a valid absolute `leaseExpiresAt` timestamp.
- **AND** `session.close` and `session.closed` MUST include a non-empty machine-readable reason.
- **AND** Unknown or malformed control fields MUST be rejected as `INVALID_PARAMS` without dispatching a Tool.

#### Scenario: Reject malformed session renewal
- **WHEN** an Engine receives `session.renew` without a valid session id or absolute expiry timestamp
- **THEN** it rejects the message as `INVALID_PARAMS` and does not extend the lease

### Requirement: Engine readiness capability advertisement
The system SHALL represent Engine readiness as a `session.ready` control message containing the protocol name/version, a non-empty Engine identifier, the bound session id, supported canonical method names, and configured workspace names. The Gateway MUST wait for a valid ready message before forwarding data-plane RPC for that session.

#### Scenario: Gateway waits for Engine readiness
- **WHEN** a WebSocket has upgraded successfully but the Engine has not sent a valid `session.ready`
- **THEN** the Gateway does not forward an Agent RPC onto that session

### Requirement: Optional absolute RPC deadline
Generic request envelopes and typed fs.read request fixtures MAY contain RFC3339 `deadlineAt`. Rust and TypeScript MUST preserve a valid deadline through parsing and serialization and reject malformed or null deadlines. Requests without this field MUST remain compatible. The Gateway MUST stamp a forwarded request with a deadline no later than its own RPC budget from HTTP receipt or the caller's earlier deadline.

#### Scenario: Shared deadline fixture
- **WHEN** both language implementations round-trip a request containing `deadlineAt`
- **THEN** both preserve the same logical deadline and normalized defaults

### Requirement: Shared process wire contract
Rust and TypeScript SHALL expose shared parameter and result DTOs for process.run, process.status, process.logs, process.stop and process.list.

#### Scenario: Required shared process wire contract behavior
- **WHEN** a protocol message is serialized or validated
- **THEN** Existing execution/MCP modules MUST consume these DTOs while retaining compatible imports.
- **AND** Process parameter parsing MUST reject unknown fields and explicit nulls; defaults, byte bounds, timeout limits, identifiers, selector exclusivity, cursor limits and result nullable fields MUST remain compatible with the existing process contract.
- **AND** Wire DTOs MUST remain usable without launching processes, including non-Unix contract tests.
- **AND** Execution path normalization MUST remain distinct from portable wire serialization and MUST preserve launchId idempotency.

#### Scenario: Default run parameters
- **WHEN** a run request omits args, cwd and timeoutMs
- **THEN** both implementations expose args [], cwd "." and timeoutMs 60000

#### Scenario: Validate requests and results across languages
- **WHEN** shared fixtures cover all five methods, task/log/list results, defaults, Unicode byte limits, nulls, unknown fields and invalid selectors
- **THEN** both implementations agree on acceptance and logical wire payload, with documented execution-only path normalization tested separately

#### Scenario: Invalid process fields remain strict
- **WHEN** a process request includes an unknown field or explicit null parameter
- **THEN** both implementations reject it as INVALID_PARAMS without weakening existing filesystem forward compatibility
