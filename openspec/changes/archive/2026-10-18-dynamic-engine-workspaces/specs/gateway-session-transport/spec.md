# Spec Delta

## ADDED Requirements

### Requirement: Repeated readiness refreshes session metadata
The Gateway SHALL accept a valid `session.ready` that arrives after the bound session is already ready, and treat it as a metadata refresh. It SHALL replace the cached `workspaces`, `processWorkspaces`, `workspaceGenerations` and `methods`, publish a session state event, and keep forwarding without closing the session. A refresh with a different `sessionId` or authenticated `engineId` SHALL be rejected with `INVALID_PARAMS` and leave the cached metadata unchanged.

#### Scenario: Workspace discovery reflects a refresh
- **WHEN** a ready session receives a refreshed `session.ready` that adds workspace `docs`
- **THEN** a subsequent `list_workspaces` for that device returns `docs` without reopening the session

#### Scenario: Mismatched refresh is rejected
- **WHEN** a refreshed `session.ready` names a different `sessionId`
- **THEN** the Gateway replies with `INVALID_PARAMS` and keeps the previous workspace metadata

#### Scenario: In-flight requests are unaffected by refresh
- **WHEN** a refreshed `session.ready` arrives while an RPC is pending
- **THEN** the pending RPC still completes or times out under its original rules
