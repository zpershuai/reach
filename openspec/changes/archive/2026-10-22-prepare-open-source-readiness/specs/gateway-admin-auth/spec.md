# Spec Delta

## MODIFIED Requirements

### Requirement: One-time administrator setup
While no administrator exists, the Gateway SHALL require a setup token from `REACH_ADMIN_SETUP_TOKEN` or a generated private file under its data directory. Generated files MUST use mode 0600, reject symlinks and unsafe permissions, remain valid across restart until setup, and be removed after setup. Tokens MUST NOT enter logs. Setup MUST set a password of at least 12 characters, confirm TOTP enrolment, invalidate the token and refuse setup once an administrator exists.

#### Scenario: Setup with the private file token
- **WHEN** no administrator exists and the owner submits the private setup token, a 12+ character password and a valid TOTP code for the shown secret
- **THEN** the administrator is created, the token is invalidated, any generated setup file is removed, and the owner is signed in

#### Scenario: Setup with the logged token
- **WHEN** setup is attempted with a token recovered from an earlier version's log that is neither the current configured token nor the current private-file token
- **THEN** the Gateway returns 403, creates no administrator, and directs the owner to the current private setup credential procedure without printing a token

#### Scenario: Setup without a token
- **WHEN** a setup request omits the token or supplies a wrong one
- **THEN** the Gateway returns 403 and creates nothing

#### Scenario: Second setup attempt
- **WHEN** an administrator already exists and any setup request arrives
- **THEN** the Gateway returns 409

#### Scenario: Restart before setup
- **WHEN** the Gateway restarts while a safe generated setup file exists and no administrator has been created
- **THEN** it reuses that token without printing or replacing it

#### Scenario: Unsafe setup file
- **WHEN** the setup file is a symlink or is readable by other users
- **THEN** startup fails before listening with a sanitized diagnostic and does not disclose or follow the file

### Requirement: Recent re-authentication for sensitive actions
Adding, removing or rotating an Engine, changing the password or TOTP, disconnecting a client, changing retention, and creating, rotating, revoking or changing a client's credential or access policy SHALL require that the session has re-entered the password within the last 10 minutes. These actions MUST retain console Origin, CSRF and audit protections.

#### Scenario: Stale session removes a device
- **WHEN** a session signed in two hours ago requests Engine removal without re-authenticating
- **THEN** the Gateway returns 403 with a re-authentication-required code and changes nothing

#### Scenario: Stale session expands client authority
- **WHEN** a console session without recent re-authentication attempts to add execute permission
- **THEN** the Gateway returns 403 without modifying policy or issuing a token

## ADDED Requirements

### Requirement: Credential management preserves one-time disclosure
The console SHALL show a delegated credential's plaintext token only in the successful creation or rotation response. Its resource policy, expiry, revocation and legacy-review state MUST remain inspectable without redisclosing the token. Failed management requests MUST make no partial policy or credential changes.

#### Scenario: Credential detail is revisited
- **WHEN** the owner reloads a client's detail view after token creation
- **THEN** the current permissions and status are visible but no plaintext token is retrievable
