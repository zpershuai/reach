# gateway-admin-auth Specification

## Purpose

Protects the Gateway web console with a single owner administrator account so the console can be exposed safely on a public Gateway origin behind TLS.

## Requirements

### Requirement: Console requires persistent storage
The Gateway SHALL enable the console and its administrator API only when `REACH_DATA_DIR` names a writable directory. Without it, `/console/` and `/api/console/*` MUST return 404 and all existing Gateway behavior MUST be unchanged.

#### Scenario: No data directory
- **WHEN** the Gateway starts without `REACH_DATA_DIR`
- **THEN** `GET /console/` returns 404 and `/heartbeat`, `/session/*`, `/grants`, `/healthz` and `/mcp` behave exactly as before

#### Scenario: Unwritable data directory
- **WHEN** `REACH_DATA_DIR` is set to a directory the Gateway cannot create or write
- **THEN** the Gateway fails before listening with an error naming the directory

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
### Requirement: Password and TOTP sign-in
Sign-in SHALL require the administrator password and a current TOTP code (RFC 6238, 30-second step, ±1 step skew). A TOTP code MUST NOT be accepted twice. Failures MUST return one generic error that does not reveal which factor failed.

#### Scenario: Correct credentials
- **WHEN** the owner submits the correct password and a fresh TOTP code
- **THEN** the Gateway sets a console session cookie and returns the administrator profile

#### Scenario: Replayed TOTP code
- **WHEN** a TOTP code that already completed a sign-in is submitted again within its validity window
- **THEN** sign-in fails with the generic error

#### Scenario: Wrong second factor
- **WHEN** the password is correct but the TOTP code is wrong
- **THEN** the response is identical to a wrong-password response

### Requirement: Recovery codes
At setup the Gateway SHALL issue ten single-use recovery codes, shown once and stored only as hashes. A recovery code MAY replace the TOTP code for one sign-in and MUST then be consumed.

#### Scenario: Lost authenticator
- **WHEN** the owner signs in with the password and an unused recovery code
- **THEN** sign-in succeeds and that recovery code no longer works

### Requirement: Console session cookie
Console sessions SHALL use an opaque random identifier in an `HttpOnly`, `SameSite=Strict`, `Path=/` cookie. The cookie MUST be `Secure` when the public origin is HTTPS. The Gateway MUST store only a hash of the identifier. Sessions MUST expire after 12 hours idle and 7 days absolute, and sign-out MUST revoke the session at once.

#### Scenario: Idle expiry
- **WHEN** a console session has made no request for 12 hours
- **THEN** its next API request returns 401 and the console shows the sign-in page

#### Scenario: Sign out
- **WHEN** the owner signs out
- **THEN** the session is deleted server-side and replaying the old cookie returns 401

### Requirement: Recent re-authentication for sensitive actions
Adding, removing or rotating an Engine, changing the password or TOTP, disconnecting a client, changing retention, and creating, rotating, revoking or changing a client's credential or access policy SHALL require that the session has re-entered the password within the last 10 minutes. These actions MUST retain console Origin, CSRF and audit protections.

#### Scenario: Stale session removes a device
- **WHEN** a session signed in two hours ago requests Engine removal without re-authenticating
- **THEN** the Gateway returns 403 with a re-authentication-required code and changes nothing

#### Scenario: Stale session expands client authority
- **WHEN** a console session without recent re-authentication attempts to add execute permission
- **THEN** the Gateway returns 403 without modifying policy or issuing a token

### Requirement: Credential management preserves one-time disclosure
The console SHALL show a delegated credential's plaintext token only in the successful creation or rotation response. Its resource policy, expiry, revocation and legacy-review state MUST remain inspectable without redisclosing the token. Failed management requests MUST make no partial policy or credential changes.

#### Scenario: Credential detail is revisited
- **WHEN** the owner reloads a client's detail view after token creation
- **THEN** the current permissions and status are visible but no plaintext token is retrievable


### Requirement: Cross-site request protection
Every state-changing `/api/console/*` request SHALL carry the session's CSRF token in a header and an `Origin` equal to the configured public origin (`REACH_PUBLIC_ORIGIN`, or the loopback listener origin when unset). Requests failing either check MUST be rejected with 403 before any effect.

#### Scenario: Forged form post
- **WHEN** a request with a valid session cookie arrives from a foreign Origin or without the CSRF header
- **THEN** the Gateway returns 403 and performs no change

#### Scenario: Public origin required for public binding
- **WHEN** `REACH_DATA_DIR` is set, the Gateway binds a non-loopback host and `REACH_PUBLIC_ORIGIN` is unset
- **THEN** the Gateway fails before listening with an error explaining that the console needs its public origin

### Requirement: Sign-in rate limiting
The Gateway SHALL limit failed sign-in, setup and re-authentication attempts per client address and globally, with exponential back-off, and return 429 while limited. Client addresses MUST come from the socket peer unless that peer is listed in `REACH_TRUSTED_PROXIES`; only then is `X-Forwarded-For` used.

#### Scenario: Password guessing
- **WHEN** one address fails sign-in 5 times within 15 minutes
- **THEN** further attempts from that address receive 429 until the back-off elapses, even with correct credentials

#### Scenario: Spoofed forwarding header
- **WHEN** an untrusted peer sends `X-Forwarded-For` with varying addresses
- **THEN** the limiter keys on the socket peer address and the header is ignored

### Requirement: Console credentials are isolated from data-plane credentials
A console session SHALL NOT authenticate `/session/*`, `/grants`, `/heartbeat` or `/mcp`. The Controller token and Engine tokens SHALL NOT authenticate `/api/console/*`. Console sign-in, sign-out, failed attempts and every administrator change MUST be recorded in the activity audit.

#### Scenario: Controller token against the console API
- **WHEN** a request to `/api/console/engines` carries `Authorization: Bearer <controller token>` and no console session
- **THEN** the Gateway returns 401

#### Scenario: Console cookie against the data plane
- **WHEN** a request to `/session/rpc` carries only a valid console session cookie
- **THEN** the Gateway rejects it exactly as an unauthenticated controller request
