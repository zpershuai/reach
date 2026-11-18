# Spec Delta

## ADDED Requirements

### Requirement: Console user accounts
The Gateway SHALL store console accounts in its database, each with a unique username, a password hash, a role of `admin` or `user`, an optional TOTP enrolment, and an enabled or disabled state. Usernames MUST be 3 to 64 characters from letters, digits, `.`, `_` and `-`, and MUST be compared case-insensitively. Passwords MUST be 12 to 1024 characters and MUST be stored only as hashes.

#### Scenario: Duplicate username
- **WHEN** an admin creates user `Alice` while user `alice` exists
- **THEN** the Gateway returns 409 `USERNAME_TAKEN` and creates nothing

#### Scenario: Short password
- **WHEN** an account is created or a password is changed to an 11-character value
- **THEN** the Gateway returns 400 `PASSWORD_LENGTH` and stores nothing

### Requirement: Role-based console authorization
A console session SHALL act with its user's current role. A `user` session MUST be able to read console state, the event stream and activity, but every other state-changing console request MUST be rejected with 403 `ROLE_FORBIDDEN` before any effect. Exceptions: sign-out, the user's own password and TOTP changes, and their own theme or language choice. Role checks MUST use the role stored now, not the role held at sign-in.

#### Scenario: Read-only user removes a device
- **WHEN** a signed-in `user` sends `DELETE /api/console/engines/nas-01` with valid CSRF and recent re-authentication
- **THEN** the Gateway returns 403 `ROLE_FORBIDDEN` and the Engine remains registered

#### Scenario: Read-only user views topology
- **WHEN** a signed-in `user` requests the console snapshot and the event stream
- **THEN** both succeed with the same content an admin would receive

#### Scenario: Demotion takes effect at once
- **WHEN** an admin demotes another admin to `user` while that user is signed in
- **THEN** that user's next mutation returns 403 `ROLE_FORBIDDEN` without signing in again

### Requirement: User management
An admin SHALL be able to list users and to create a user, change a user's role, disable or enable a user, reset a user's password, remove a user's TOTP enrolment and delete a user. Every one of these changes MUST require recent re-authentication and MUST be recorded as an admin action that names the target username. Listings MUST NOT include password hashes, TOTP secrets or recovery codes.

#### Scenario: Admin creates a viewer
- **WHEN** a recently re-authenticated admin creates user `ops` with role `user` and a 14-character password
- **THEN** `ops` can sign in with that password and has read-only access

#### Scenario: Stale admin session creates a user
- **WHEN** an admin whose last authentication is two hours old creates a user
- **THEN** the Gateway returns 403 `REAUTH_REQUIRED` and creates nothing

### Requirement: At least one enabled admin
The Gateway SHALL refuse any change that would leave no enabled `admin` account. This covers deleting, disabling or demoting the last enabled admin, including the acting admin themself. Such a request MUST return 409 `LAST_ADMIN` and change nothing.

#### Scenario: Sole admin demotes themself
- **WHEN** the only enabled admin changes their own role to `user`
- **THEN** the Gateway returns 409 `LAST_ADMIN` and the role is unchanged

### Requirement: Account changes revoke sessions
Disabling or deleting a user, resetting their password, or removing their TOTP enrolment SHALL revoke all of that user's console sessions at once. A user changing their own password MUST keep the current session and revoke their other sessions. A disabled user MUST NOT be able to sign in or re-authenticate.

#### Scenario: Disabled while signed in
- **WHEN** an admin disables user `ops` while `ops` has an open console
- **THEN** the next request from that console returns 401 and sign-in as `ops` fails with the generic error

### Requirement: Self-service account settings
Every signed-in user, whatever their role, SHALL be able to change their own password after confirming the current one. They SHALL also be able to enable TOTP by confirming a code from a newly shown secret, and to disable their own TOTP after recent re-authentication with a current TOTP or recovery code.

#### Scenario: User enables TOTP
- **WHEN** user `ops` requests TOTP enrolment, scans the secret and submits a valid code
- **THEN** TOTP is enabled for `ops`, ten recovery codes are shown once, and later sign-ins as `ops` require a code

#### Scenario: Wrong current password
- **WHEN** a user submits a password change with a wrong current password
- **THEN** the password is unchanged and the failure counts toward rate limiting

### Requirement: Offline password reset
The Gateway executable SHALL provide `admin reset-password <username>`, run on the Gateway host against `REACH_DATA_DIR`. It SHALL read the new password from an interactive prompt or standard input, never from an argument. It sets the password, enables the account, clears its TOTP enrolment and recovery codes, and revokes its sessions. The command MUST NOT print secrets and MUST be recorded in the activity audit.

#### Scenario: Owner lost their authenticator
- **WHEN** the operator runs `reach-gateway admin reset-password admin` and enters a 16-character password twice
- **THEN** `admin` can sign in with that password and no TOTP code, and earlier `admin` sessions return 401

#### Scenario: Unknown username
- **WHEN** the command names a username that does not exist
- **THEN** it exits non-zero with an error naming the username and changes nothing

### Requirement: Existing administrator migration
On first start after upgrade, the Gateway SHALL convert an existing single administrator into user `admin` with role `admin`. The migration SHALL keep that account's password hash, TOTP secret, replay state and unused recovery codes, so TOTP stays enabled. Open console sessions MAY be revoked. The migration MUST be atomic and MUST NOT run twice.

#### Scenario: Upgraded Gateway
- **WHEN** a Gateway whose database holds the old administrator starts on the new version
- **THEN** signing in as `admin` with the old password and a current TOTP code succeeds, and no setup token is requested

## MODIFIED Requirements

### Requirement: One-time administrator setup
While no user account exists, the Gateway SHALL require a setup token from `REACH_ADMIN_SETUP_TOKEN` or a generated private file under its data directory. Generated files MUST use mode 0600, reject symlinks and unsafe permissions, remain valid across restart until setup, and be removed after setup. Tokens MUST NOT enter logs. Setup MUST create the first account with role `admin` from a username and a password of at least 12 characters. It MUST then invalidate the token and refuse setup once any account exists. Setup MUST NOT require TOTP enrolment.

#### Scenario: Setup with the private file token
- **WHEN** no account exists and the owner submits the private setup token, a valid username and a 12+ character password
- **THEN** an `admin` account is created without TOTP, the token is invalidated, any generated setup file is removed, and the owner is signed in

#### Scenario: Setup with the logged token
- **WHEN** setup is attempted with a token recovered from an earlier version's log that is neither the current configured token nor the current private-file token
- **THEN** the Gateway returns 403, creates no account, and directs the owner to the current private setup credential procedure without printing a token

#### Scenario: Setup without a token
- **WHEN** a setup request omits the token or supplies a wrong one
- **THEN** the Gateway returns 403 and creates nothing

#### Scenario: Second setup attempt
- **WHEN** an account already exists and any setup request arrives
- **THEN** the Gateway returns 409

#### Scenario: Restart before setup
- **WHEN** the Gateway restarts while a safe generated setup file exists and no account has been created
- **THEN** it reuses that token without printing or replacing it

#### Scenario: Unsafe setup file
- **WHEN** the setup file is a symlink or is readable by other users
- **THEN** startup fails before listening with a sanitized diagnostic and does not disclose or follow the file

### Requirement: Password and TOTP sign-in
Sign-in SHALL require a username and that user's password. When the user has enabled TOTP, sign-in MUST also require a current TOTP code (RFC 6238, 30-second step, ±1 step skew) or an unused recovery code. A TOTP code MUST NOT be accepted twice for the same user. Unknown usernames, disabled accounts, wrong passwords and wrong codes MUST return one generic error with comparable timing. A correct password without the required code MUST return `TOTP_REQUIRED` and issue no session.

#### Scenario: Correct credentials
- **WHEN** a user without TOTP submits the correct username and password
- **THEN** the Gateway sets a console session cookie and returns that user's id, username and role

#### Scenario: TOTP user omits the code
- **WHEN** a user with TOTP submits the correct username and password and no code
- **THEN** the Gateway returns 401 with code `TOTP_REQUIRED`, sets no session cookie, and the console asks for the code

#### Scenario: Correct credentials with TOTP
- **WHEN** a user with TOTP submits the correct username, password and a fresh TOTP code
- **THEN** the Gateway sets a console session cookie and returns the user profile

#### Scenario: Replayed TOTP code
- **WHEN** a TOTP code that already completed a sign-in for that user is submitted again within its validity window
- **THEN** sign-in fails with the generic error

#### Scenario: Wrong second factor
- **WHEN** the password is correct but the TOTP code is wrong
- **THEN** the response is identical to a wrong-password response

#### Scenario: Unknown username
- **WHEN** sign-in names a username that does not exist
- **THEN** the response is identical to a wrong-password response and counts toward rate limiting

### Requirement: Recovery codes
When a user enables TOTP, the Gateway SHALL issue that user ten single-use recovery codes, shown once and stored only as hashes. A recovery code MAY replace the TOTP code for one sign-in of that user and MUST then be consumed. Disabling or removing a user's TOTP MUST delete that user's recovery codes.

#### Scenario: Lost authenticator
- **WHEN** a TOTP user signs in with their password and an unused recovery code
- **THEN** sign-in succeeds and that recovery code no longer works

#### Scenario: Another user's code
- **WHEN** user `ops` submits a valid recovery code that belongs to user `admin`
- **THEN** sign-in fails with the generic error and the code remains usable by `admin`

### Requirement: Recent re-authentication for sensitive actions
Adding, removing or rotating an Engine, changing a password or TOTP, disconnecting a client, changing retention, managing users, and creating, rotating, revoking or changing a client's credential or access policy SHALL require that the session's user re-entered their password within the last 10 minutes. These actions MUST retain console Origin, CSRF, role and audit protections.

#### Scenario: Stale session removes a device
- **WHEN** an admin session signed in two hours ago requests Engine removal without re-authenticating
- **THEN** the Gateway returns 403 with a re-authentication-required code and changes nothing

#### Scenario: Stale session expands client authority
- **WHEN** an admin session without recent re-authentication attempts to add execute permission
- **THEN** the Gateway returns 403 without modifying policy or issuing a token

### Requirement: Console credentials are isolated from data-plane credentials
A console session SHALL NOT authenticate `/session/*`, `/grants`, `/heartbeat` or `/mcp`. The Controller token and Engine tokens SHALL NOT authenticate `/api/console/*`. Console sign-in, sign-out, failed attempts, every account change and every administrator change MUST be recorded in the activity audit with the acting username when known.

#### Scenario: Controller token against the console API
- **WHEN** a request to `/api/console/engines` carries `Authorization: Bearer <controller token>` and no console session
- **THEN** the Gateway returns 401

#### Scenario: Console cookie against the data plane
- **WHEN** a request to `/session/rpc` carries only a valid console session cookie
- **THEN** the Gateway rejects it exactly as an unauthenticated controller request
