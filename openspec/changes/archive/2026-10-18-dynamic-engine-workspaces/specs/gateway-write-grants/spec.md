# Spec Delta

## ADDED Requirements

### Requirement: Grants follow workspace availability
When the Gateway receives a refreshed `session.ready`, it SHALL revoke every mutation grant and process execution grant for a workspace that is no longer advertised, or whose `workspaceGenerations` token changed. It SHALL also revoke every process execution grant for a workspace absent from the refreshed `processWorkspaces`. A revoked grant SHALL be rejected with `PERMISSION_DENIED` and MUST NOT be forwarded. Grants for unchanged workspaces SHALL remain valid.

#### Scenario: Repointed workspace invalidates grants
- **WHEN** a mutation grant was issued for workspace `docs` and a refreshed ready reports a new generation for `docs`
- **THEN** a mutation presenting that grant is rejected with `PERMISSION_DENIED` and not forwarded

#### Scenario: Removed workspace invalidates grants
- **WHEN** a grant was issued for workspace `docs` and a refreshed ready no longer advertises `docs`
- **THEN** the grant is rejected with `PERMISSION_DENIED`

#### Scenario: Execution disabled invalidates process execution grants only
- **WHEN** a refreshed ready keeps workspace `scripts` with the same generation but removes it from `processWorkspaces`
- **THEN** process execution grants for `scripts` are rejected and mutation grants for `scripts` remain valid

#### Scenario: Unchanged workspace keeps grants
- **WHEN** a refreshed ready only adds workspace `docs`
- **THEN** an existing grant for `default` remains valid

Process control grants are scoped only to a `processId`, with no workspace identity. They remain valid until expiry; the Engine terminates affected owned processes during reload, and the grant can only control that original process.
