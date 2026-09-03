## MODIFIED Requirements

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
