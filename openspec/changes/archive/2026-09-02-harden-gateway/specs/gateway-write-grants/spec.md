## Purpose

Defines gateway-issued grants that authorize narrowly scoped filesystem mutations without trusting client-created identifiers.

## ADDED Requirements

### Requirement: Gateway-issued mutation grants
The gateway SHALL accept a local JSON `POST /grants` request with non-empty `workspace` and `path` strings and a non-empty `methods` array containing supported mutation methods. It SHALL return a gateway-generated non-empty `grantId` and an `expiresAt` timestamp. A grant SHALL be valid only until its expiry and only for its issued workspace, exact file or path-prefix scope, and listed methods.

#### Scenario: Issue a scoped grant
- **WHEN** a caller posts a valid workspace, path, and `fs.write` method to `/grants`
- **THEN** the gateway returns HTTP 200 with a newly issued `grantId` and `expiresAt`

#### Scenario: Reject an invalid grant request
- **WHEN** a caller posts malformed fields or an unsupported method to `/grants`
- **THEN** the gateway returns HTTP 400 and does not issue a grant

### Requirement: Mutation authorization validation
The gateway SHALL require `fs.write` and `fs.edit` requests to present a live issued grant that matches the requested workspace, path, and method. It MUST reject a missing, forged, expired, workspace-mismatched, path-mismatched, or method-mismatched grant with `PERMISSION_DENIED` before the filesystem mutation occurs.

#### Scenario: Reject a forged grant
- **WHEN** a mutation request presents a grant identifier that the gateway did not issue
- **THEN** the request fails with `PERMISSION_DENIED` and the target file is unchanged

#### Scenario: Accept a matching live grant
- **WHEN** a mutation request presents an unexpired grant covering its workspace, path, and method
- **THEN** the gateway dispatches the mutation normally
