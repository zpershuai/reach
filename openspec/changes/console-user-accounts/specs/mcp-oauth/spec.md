# Spec Delta

## MODIFIED Requirements

### Requirement: Owner approval with second factor
Authorization SHALL use the code flow with S256 PKCE and exact redirect URI matching. The approval page MUST require the username and password of an enabled `admin` account, plus a fresh TOTP or recovery code when that account has TOTP enabled. It MUST share sign-in rate limits and audit, accept submissions only from the Gateway origin, and record approvals as admin actions naming the approving username. Accounts with role `user` MUST NOT be able to approve. Denial MUST redirect with `access_denied`. New approvals MUST require explicit Engine, workspace and read/write/execute selection without preselected global access.

#### Scenario: Native browser form
- **WHEN** an admin submits the approval page in a browser
- **THEN** the page's referrer policy lets the browser send the Gateway origin, and the decision is accepted

#### Scenario: Missing PKCE
- **WHEN** an authorization request omits `code_challenge` or uses `plain`
- **THEN** the Gateway redirects to the client with `invalid_request`

#### Scenario: Wrong second factor
- **WHEN** an admin with TOTP enabled submits a correct password with a wrong code
- **THEN** no code is issued and the failure counts toward sign-in rate limiting

#### Scenario: Admin without TOTP approves
- **WHEN** an enabled admin without TOTP submits their correct username and password and selects resources
- **THEN** an authorization code is issued and the approval is audited with that username

#### Scenario: Read-only user tries to approve
- **WHEN** an account with role `user` submits correct credentials on the approval page
- **THEN** no code is issued, the page shows the same generic credentials error, and the attempt is audited as a failed approval

#### Scenario: Scope is not explicitly selected
- **WHEN** a new approval has no selected resource permissions
- **THEN** no usable data-plane authority is issued and the page asks the owner to select resources and permissions

#### Scenario: A read-only app is approved
- **WHEN** the owner selects only read access to `engine-a/docs`
- **THEN** the resulting client can read that workspace but cannot mutate files, run scripts or access another Engine
