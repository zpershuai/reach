## Purpose

Defines the portable Round 1 Reach RPC wire contract so Rust and TypeScript peers exchange identical `fs.read` messages.

## ADDED Requirements

### Requirement: Reach RPC request envelope
The system SHALL represent a Round 1 request as a JSON object with required camelCase fields `type`, `protocol`, `version`, `sessionId`, `requestId`, `method`, and `params`. `type` MUST be `request`, `protocol` MUST be `reach-rpc`, and `version` MUST be `1.0`. `sessionId`, `requestId`, and `method` MUST be non-empty strings. A request MAY include `permission`, which, when present, MUST be an object with the non-empty string field `grantId`. Implementations MUST ignore unknown object fields. Missing required fields, invalid field types, invalid literal values, empty required strings, or invalid numeric ranges MUST be rejected as `INVALID_PARAMS`.

#### Scenario: Parse a valid fs.read envelope
- **WHEN** a peer receives a request with the required Reach RPC fields and `method` set to `fs.read`
- **THEN** it accepts the envelope as a `reach-rpc` version `1.0` request

#### Scenario: Ignore forward-compatible fields
- **WHEN** a valid request includes an unrecognized envelope, permission, or parameter field
- **THEN** it accepts the request and omits the unrecognized field when serializing the DTO

#### Scenario: Reject an invalid envelope
- **WHEN** a request omits a required field, has a wrong field type, or uses a protocol other than `reach-rpc`
- **THEN** it rejects the request as `INVALID_PARAMS`

### Requirement: fs.read parameters
The system SHALL define `fs.read` parameters as a JSON object containing non-empty string fields `workspace` and `path`, plus integer `startLine` and `maxLines`. `startLine` MUST be at least 1 and defaults to 1 when omitted. `maxLines` MUST be between 1 and 10,000 inclusive and defaults to 200 when omitted. Implementations MUST reject invalid parameter field types, empty strings, non-integers, and out-of-range integers as `INVALID_PARAMS`.

#### Scenario: Apply fs.read defaults
- **WHEN** a valid `fs.read` request omits `startLine` and `maxLines`
- **THEN** the parsed and serialized parameters contain `startLine` 1 and `maxLines` 200

#### Scenario: Reject invalid fs.read range
- **WHEN** an `fs.read` request supplies `startLine` 0 or `maxLines` greater than 10,000
- **THEN** it rejects the request as `INVALID_PARAMS`

### Requirement: fs.read result
The system SHALL represent an `fs.read` result as a JSON object containing string `content`, integer `startLine`, integer `endLine`, integer `totalLines`, boolean `truncated`, and string `revision`. `startLine` MUST be at least 1, `endLine` MUST be at least `startLine - 1`, and `totalLines` MUST be non-negative. `revision` MUST be the lowercase hexadecimal SHA-256 digest of the complete file content and is otherwise opaque to clients.

#### Scenario: Represent a truncated file read
- **WHEN** a file read returns fewer lines than the file contains due to its requested limit
- **THEN** the result contains the returned line range, total line count, `truncated` true, and the complete-content revision

### Requirement: Cross-language fixture compatibility
The system SHALL provide a canonical JSON fixture for a valid `fs.read` request. Rust and TypeScript contract implementations MUST each parse and serialize this fixture, producing the same logical payload with defaulted values and without unknown fields.

#### Scenario: Round-trip the fixture in both implementations
- **WHEN** the Round 1 fixture validation is run
- **THEN** both Rust Serde and TypeScript Zod parse and serialize the request successfully with equivalent logical payloads
