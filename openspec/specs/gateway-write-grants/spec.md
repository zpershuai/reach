## Purpose

Defines gateway-issued grants that authorize narrowly scoped filesystem mutations without trusting client-created identifiers.

## Requirements

### Requirement: Gateway-issued mutation grants
The gateway SHALL accept a local JSON `POST /grants` request with non-empty `workspace` and `path` strings and a non-empty `methods` array containing supported mutation methods. It SHALL return a gateway-generated non-empty `grantId` and an `expiresAt` timestamp. A grant SHALL be valid only until its expiry and only for its issued workspace, exact file or path-prefix scope, and listed methods. Grants authorize mutations that the gateway will later forward to the connected Engine; they do not authorize the Engine to mutate files on its own initiative.

#### Scenario: Issue a scoped grant
- **WHEN** a caller posts a valid workspace, path, and `fs.write` method to `/grants`
- **THEN** the gateway returns HTTP 200 with a newly issued `grantId` and `expiresAt`

#### Scenario: Reject an invalid grant request
- **WHEN** a caller posts malformed fields or an unsupported method to `/grants`
- **THEN** the gateway returns HTTP 400 and does not issue a grant

### Requirement: Mutation authorization validation
Before sending `fs.write` or `fs.edit` to the Engine on a live session, the gateway SHALL require a live issued grant that matches the requested workspace, path, and method. It MUST unwrap nested `tool.call` envelopes (bounded depth) solely to identify the leaf mutation method and path for grant checks so nesting cannot hide a mutation from authorization. Nested `tool.call` — a `tool.call` whose unwrap leaves a `tool.call`, or whose unwrap fails — MUST be rejected with `INVALID_PARAMS` BEFORE grant matching and MUST NOT be forwarded, so the response code never depends on grant state. Grant matching applies only to supported non-nested mutation leaves. It MUST reject a missing, forged, expired, workspace-mismatched, path-mismatched, or method-mismatched grant with `PERMISSION_DENIED` and MUST NOT forward that mutation to the Engine. The Engine SHALL refuse to execute `fs.write` or `fs.edit` unless the inbound session request includes a `permission.grantId` and the gateway has marked that request as grant-checked for the live session (by only forwarding mutations that passed gateway validation). The Engine MUST NOT invent or accept operator-supplied grant identifiers outside that gateway-forwarded path.

#### Scenario: Reject a forged grant
- **WHEN** a mutation request presents a grant identifier that the gateway did not issue
- **THEN** the gateway returns `PERMISSION_DENIED`, does not forward the mutation, and the Engine workspace file is unchanged

#### Scenario: Accept a matching live grant
- **WHEN** a mutation request presents an unexpired grant covering its workspace, path, and method
- **THEN** the gateway forwards the mutation to the Engine and the Engine dispatches it against its local workspace

#### Scenario: Nested tool.call cannot bypass grant checks
- **WHEN** a caller wraps `fs.write` inside nested `tool.call` envelopes without a matching grant
- **THEN** the gateway rejects the request with `INVALID_PARAMS` before grant matching and does not forward it (it never reaches `PERMISSION_DENIED`)

#### Scenario: Nested tool.call is not forwarded even with a grant
- **WHEN** a caller posts nested `tool.call` envelopes that unwrap to a granted `fs.write`
- **THEN** the gateway still rejects the nested envelope with `INVALID_PARAMS` before forward because nested `tool.call` is not an allowed dispatch form and its rejection is independent of grant state

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
