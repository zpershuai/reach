# Spec Delta

## MODIFIED Requirements

### Requirement: Owner approval with second factor
Authorization SHALL use the code flow with S256 PKCE and exact redirect URI matching. The approval page MUST require the administrator password and a fresh TOTP or recovery code, share sign-in rate limits and audit, accept submissions only from the Gateway origin, and record approvals as admin actions. Denial MUST redirect with `access_denied`. New approvals MUST require explicit Engine, workspace and read/write/execute selection without preselected global access.

#### Scenario: Native browser form
- **WHEN** the owner submits the approval page in a browser
- **THEN** the page's referrer policy lets the browser send the Gateway origin, and the decision is accepted

#### Scenario: Missing PKCE
- **WHEN** an authorization request omits `code_challenge` or uses `plain`
- **THEN** the Gateway redirects to the client with `invalid_request`

#### Scenario: Wrong second factor
- **WHEN** the owner submits a correct password with a wrong code
- **THEN** no code is issued and the failure counts toward sign-in rate limiting

#### Scenario: Scope is not explicitly selected
- **WHEN** a new approval has no selected resource permissions
- **THEN** no usable data-plane authority is issued and the page asks the owner to select resources and permissions

#### Scenario: A read-only app is approved
- **WHEN** the owner selects only read access to `engine-a/docs`
- **THEN** the resulting client can read that workspace but cannot mutate files, run scripts or access another Engine

### Requirement: MCP sessions are bound to their principal
An HTTP MCP session SHALL bind the authenticated Owner, delegated credential or OAuth client principal that initialized it. Requests from another principal using its `Mcp-Session-Id` MUST receive 404 without affecting it. OAuth refresh MUST keep the same principal without expanding its current policy. Existing sessions and shared ownership pools MUST recheck credential validity and policy on each request.

#### Scenario: Another client presents a session id
- **WHEN** OAuth client B sends a POST or DELETE with client A's `Mcp-Session-Id`
- **THEN** B receives 404 and A's session continues

#### Scenario: Token refresh retains policy
- **WHEN** a scoped OAuth client refreshes its token and reuses its existing MCP session
- **THEN** it retains its identity and current restricted policy without receiving Owner authority

#### Scenario: Permission is reduced while a pool is idle
- **WHEN** the owner reduces a client's policy during the shared Engine ownership pool's idle grace
- **THEN** affected ownership drains and a later MCP session cannot reuse the removed authority

## ADDED Requirements

### Requirement: OAuth revocation cleans up owned work
Revoking an OAuth client SHALL invalidate its access and refresh tokens, pending codes, policy-bound grants and owned MCP/Engine sessions. Cleanup MUST be bounded and isolated from other principals, and cleanup failure MUST retain ownership for retry without admitting further client work. Refresh-token replay revocation MUST use the same cleanup path.

#### Scenario: App is revoked with a running task
- **WHEN** the owner revokes an app whose task is running
- **THEN** further requests return 401, the task and owned sessions drain, and another app's sessions remain unaffected

#### Scenario: A refresh token is replayed
- **WHEN** a previously rotated refresh token is replayed
- **THEN** all authority in that token family is revoked and its owned work is cleaned up rather than remaining reachable through a cached MCP session
