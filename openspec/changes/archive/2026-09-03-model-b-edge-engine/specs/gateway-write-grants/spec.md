## MODIFIED Requirements

### Requirement: Gateway-issued mutation grants
The gateway SHALL accept a local JSON `POST /grants` request with non-empty `workspace` and `path` strings and a non-empty `methods` array containing supported mutation methods. It SHALL return a gateway-generated non-empty `grantId` and an `expiresAt` timestamp. A grant SHALL be valid only until its expiry and only for its issued workspace, exact file or path-prefix scope, and listed methods. Grants authorize mutations that the gateway will later forward to the connected Engine; they do not authorize the Engine to mutate files on its own initiative.

#### Scenario: Issue a scoped grant
- **WHEN** a caller posts a valid workspace, path, and `fs.write` method to `/grants`
- **THEN** the gateway returns HTTP 200 with a newly issued `grantId` and `expiresAt`

#### Scenario: Reject an invalid grant request
- **WHEN** a caller posts malformed fields or an unsupported method to `/grants`
- **THEN** the gateway returns HTTP 400 and does not issue a grant

### Requirement: Mutation authorization validation
Before sending `fs.write` or `fs.edit` to the Engine on a live session, the gateway SHALL require a live issued grant that matches the requested workspace, path, and method. It MUST reject a missing, forged, expired, workspace-mismatched, path-mismatched, or method-mismatched grant with `PERMISSION_DENIED` and MUST NOT forward that mutation to the Engine. The Engine SHALL refuse to execute `fs.write` or `fs.edit` unless the inbound session request includes a `permission.grantId` and the gateway has marked that request as grant-checked for the live session (by only forwarding mutations that passed gateway validation). The Engine MUST NOT invent or accept operator-supplied grant identifiers outside that gateway-forwarded path.

#### Scenario: Reject a forged grant
- **WHEN** a mutation request presents a grant identifier that the gateway did not issue
- **THEN** the gateway returns `PERMISSION_DENIED`, does not forward the mutation, and the Engine workspace file is unchanged

#### Scenario: Accept a matching live grant
- **WHEN** a mutation request presents an unexpired grant covering its workspace, path, and method
- **THEN** the gateway forwards the mutation to the Engine and the Engine dispatches it against its local workspace
