# Spec Delta

## ADDED Requirements

### Requirement: Grants bind authenticated policy authority
Every issued filesystem or process grant SHALL bind the authenticated principal, target Engine and current policy revision in addition to its existing operation scope and expiry. Issuance and use MUST require current matching policy. Client-provided grant IDs or permission-kind hints MUST NOT override this identity binding. Automatic MCP grant acquisition MUST remain policy-constrained and MUST NOT be described as human approval.

#### Scenario: A grant is shared between principals
- **WHEN** client B submits an otherwise valid filesystem or process grant issued to client A
- **THEN** Gateway returns `PERMISSION_DENIED` without forwarding, even when both clients can access the same workspace

#### Scenario: Execute authorization is missing
- **WHEN** a read/write client requests an execution grant through REST or the in-process MCP path
- **THEN** no execution grant is issued and no process starts

#### Scenario: Grant is used on another Engine
- **WHEN** a grant issued for `engine-a` is presented against `engine-b` with the same workspace and path names
- **THEN** Gateway rejects it before forwarding

### Requirement: Policy changes invalidate affected grants
Revocation, expiry, credential rotation or policy reduction SHALL invalidate the affected principal's grants before later requests are admitted. The Gateway MUST check policy again before forwarding previously queued requests. Workspace removal, workspace generation changes and process-workspace removal MUST retain their existing revocation behavior.

#### Scenario: A queued write loses its authority
- **WHEN** write access is removed after a write was queued but before forwarding
- **THEN** Gateway rejects the write with `PERMISSION_DENIED` and the Engine does not receive it

#### Scenario: An atomic mutation already committed
- **WHEN** access is removed after the Engine passed its atomic commit boundary
- **THEN** the system denies further work and documents that the completed write is not rolled back

#### Scenario: Unrelated client policy is changed
- **WHEN** client A's policy changes without affecting client B's policy or workspace availability
- **THEN** B's valid grants and session remain usable
