## MODIFIED Requirements

### Requirement: Reach RPC request envelope
The system SHALL represent a request as a JSON object with required camelCase fields `type`, `protocol`, `version`, `sessionId`, `requestId`, `method`, and `params`. `type` MUST be `request`, `protocol` MUST be `reach-rpc`, and `version` MUST be `1.0`. `sessionId`, `requestId`, and `method` MUST be non-empty strings and `params` MUST be an object. A request MAY include `permission`, which, when present, MUST be an object with the non-empty string field `grantId`. Implementations MUST ignore unknown object fields. Missing required fields, invalid field types, invalid literal values, empty required strings, or invalid numeric ranges MUST be rejected as `INVALID_PARAMS`.

#### Scenario: Parse a valid fs.read envelope
- **WHEN** a peer receives a request with the required Reach RPC fields and `method` set to `fs.read`
- **THEN** it accepts the envelope as a `reach-rpc` version `1.0` request

#### Scenario: Ignore forward-compatible fields
- **WHEN** a valid request includes an unrecognized envelope, permission, or parameter field
- **THEN** it accepts the request and omits the unrecognized field when serializing the DTO

#### Scenario: Reject an invalid envelope
- **WHEN** a request omits a required field, has a wrong field type, uses a protocol other than `reach-rpc`, or uses a version other than `1.0`
- **THEN** it rejects the request as `INVALID_PARAMS`
