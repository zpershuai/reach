## MODIFIED Requirements

### Requirement: fs.read parameters
The system SHALL define `fs.read` parameters as a JSON object containing non-empty string fields `workspace` and `path`, plus integer `startLine` and `maxLines`. `startLine` MUST be at least 1 and defaults to 1 when omitted. `maxLines` MUST be between 1 and 10,000 inclusive and defaults to 200 when omitted. Implementations MUST reject invalid parameter field types, empty strings, non-integers, and out-of-range integers as `INVALID_PARAMS`. Implementations MUST ignore unknown parameter fields.

#### Scenario: Apply fs.read defaults
- **WHEN** a valid `fs.read` request omits `startLine` and `maxLines`
- **THEN** the parsed and serialized parameters contain `startLine` 1 and `maxLines` 200

#### Scenario: Reject invalid fs.read range
- **WHEN** an `fs.read` request supplies `startLine` 0 or `maxLines` greater than 10,000
- **THEN** it rejects the request as `INVALID_PARAMS`

### Requirement: fs.read result
The system SHALL represent an `fs.read` result as a JSON object containing string `content`, integer `startLine`, integer `endLine`, integer `totalLines`, boolean `truncated`, and string `revision`. `startLine` MUST be at least 1, `endLine` MUST be at least `startLine - 1`, and `totalLines` MUST be non-negative. `revision` MUST be the lowercase hexadecimal SHA-256 digest of the complete file content and is otherwise opaque to clients. The result MUST be serializable with camelCase property names.

#### Scenario: Represent a truncated file read
- **WHEN** a file read returns fewer lines than the file contains due to its requested limit
- **THEN** the result contains the returned line range, total line count, `truncated` true, and the complete-content revision

## ADDED Requirements

### Requirement: Round 4 filesystem DTO compatibility
The system SHALL represent parameters and results for `fs.write`, `fs.edit`, `fs.list`, `fs.glob`, `fs.stat`, and `fs.grep` using camelCase JSON fields. Rust Serde and TypeScript Zod implementations MUST reject invalid parameters as `INVALID_PARAMS` and ignore unknown object fields.

#### Scenario: Match filesystem DTO parsing across languages
- **WHEN** Rust and TypeScript parse the same valid Round 4 filesystem request with unknown fields
- **THEN** each produces an equivalent logical payload with defaults applied and unknown fields omitted
