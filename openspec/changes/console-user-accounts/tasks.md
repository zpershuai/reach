# Tasks

## 1. Account data model and migration

- [x] 1.1 Append the `users` migration to `console-api/store.ts`. It creates `users`, copies admin row 1 as `admin`/`admin`, rebuilds `recovery_codes` and `console_sessions` keyed by `user_id`, and drops `admin`, all in one transaction (design D1). Verify with a `store.test.ts` case: a DB built at the previous `user_version` with an admin, TOTP step and recovery codes migrates to an equivalent `users` row and codes, and reopening does not re-run the migration.
- [x] 1.2 Refactor `AdminCredentials` in `credentials.ts` into per-user helpers, so `acceptFactor(userId, code)`, recovery-code issue/delete and replay-step update are scoped to one user. Add username normalisation and validation (3–64 chars, `[A-Za-z0-9._-]`, case-insensitive key). Verify with `credentials.test.ts`: one user's recovery code is rejected for another user, a replayed step is rejected per user, and invalid usernames are refused.

## 2. Sign-in, setup and role enforcement (Gateway)

- [x] 2.1 Implement `verifyAccount` in `auth.ts`: dummy-hash timing for unknown users, disabled = fail, `totp_required` for TOTP users without a code, rate-limit and audit only on failure (design D2). Rewire `login` and `reauth` to use it. Verify with `auth.test.ts` cases: unknown user, wrong password, disabled and wrong code all return the identical `INVALID_CREDENTIALS` body; `TOTP_REQUIRED` is returned only for a correct password and sets no cookie; a non-TOTP user signs in with username + password.
- [x] 2.2 Simplify `setup` to `{token, username, password}`, creating an admin without TOTP; "exists" now means any user exists. Verify the existing setup-token tests still pass, updated for the new body, plus a new case where setup issues no TOTP secret and returns a session.
- [x] 2.3 Change `/me` and the sign-in responses to return `user: {id, username, role, totpEnabled}`. Join the session lookup to `users` so role and disabled state are read on every request; a disabled user's session returns 401. Verify with an `auth.test.ts` case: disabling a user makes their existing cookie return 401.
- [x] 2.4 Extend `auth.require` with a required role. In `server.ts`, make every mutation admin-only except the self-service allow-list: `account/*`, plus `settings` when only the theme changes (design D3). Verify with a test that walks every mutating console route as a `user` session and expects 403 `ROLE_FORBIDDEN`, except allow-listed routes; also check that `GET` snapshot, activity and the SSE stream succeed for `user`.
- [x] 2.5 Pass the acting user into `auth.action`, so `admin.action` events carry `console`/username/`verified:true`, with `Setup` and `Host CLI` for the account-less paths (design D7). Verify with `attribution.test.ts`: an Engine removal by `alice` is labelled `alice`.
- [x] 2.6 Add the `ADMIN_WITHOUT_TOTP` snapshot warning (code and message, additive) while any enabled admin has TOTP off. Verify with a `readiness.test.ts`/server test: the warning appears and clears once TOTP is enabled.
- [x] 2.7 Add the new error codes (`TOTP_REQUIRED`, `ROLE_FORBIDDEN`, `USERNAME_TAKEN`, `LAST_ADMIN`) and keep existing codes unchanged. Verify with the console-error-code test that the new codes are present and old ones are unchanged.

## 3. User management and self-service APIs

- [x] 3.1 Implement the `/api/console/users` routes (list, create, patch role/disabled, reset password, remove TOTP, delete). Make them admin-only with recent re-authentication. Enforce the last-admin check and session revocation in the same transaction as the write (design D4). Verify with tests for: creating a duplicate case-insensitive username → 409 `USERNAME_TAKEN`; demoting, disabling or deleting the last enabled admin → 409 `LAST_ADMIN`; disabling or resetting revokes that user's sessions; listings never contain hashes or secrets; a stale session → `REAUTH_REQUIRED`.
- [x] 3.2 Implement `/api/console/account/password` (current password required; keeps the current session and revokes the user's others) and `/account/totp/begin|confirm`, plus `DELETE /account/totp`. Hold the pending secret on the session for 10 minutes; confirm returns ten recovery codes; disabling needs recent re-authentication and deletes the codes. Verify with tests: enrol → next sign-in requires a code; a wrong current password counts toward rate limiting; disabling TOTP removes the recovery codes.

## 4. OAuth approval and offline reset

- [x] 4.1 Add a username field to the `/oauth/authorize` approval page. Replace `verifyOwner` with `verifyAccount` plus an admin-role check: the TOTP field is only required when the account has TOTP, and `user` accounts get the generic error. Audit the approval with the username. Update the en/zh-CN messages in `oauth-messages.ts`. Verify with `oauth.test.ts`: an admin without TOTP approves; a `user` with correct credentials is refused and audited; a wrong code still counts toward rate limits; the Chinese page renders the new label.
- [x] 4.2 Add `reach-gateway admin reset-password <username>` to `gateway-main.ts` (design D6). The password comes from a no-echo TTY prompt with confirmation, or from stdin; the command clears TOTP and codes, enables the account, revokes sessions and writes a `Host CLI` audit row. Verify with a test that runs the built entry point against a temp `REACH_DATA_DIR`: piping a password over stdin resets the account, an unknown username exits non-zero and leaves the DB unchanged, and no secret appears on stdout or stderr.
- [x] 4.3 Document setup (token + username + password), roles, per-user TOTP, the offline reset and the upgrade backup/rollback steps in `docs/deployment.md` and `docs/deployment_cn.md`, using generic example paths and service names only (AGENTS.md). Verify that the documented reset command matches the CLI's `--help` output.

## 5. Console sign-in page

- [x] 5.1 Build `BrandVisual`: an inline, `aria-hidden` SVG of bot glyphs → Gateway → device glyphs, reusing `Glyph` and the topology colour tokens, with CSS `offset-path` particles disabled under `prefers-reduced-motion`, and the product name and tagline as real text (design D8). Verify with a component test: the SVG is `aria-hidden`, it renders no data from the API, and under reduced motion it has no animated elements.
- [x] 5.2 Rewrite `Auth.tsx` as `AuthLayout` + `SignInForm` + `SetupForm`: two columns at ≥960 px and a banner plus full-width form below that. Sign-in sends username and password, shows the code field after `TOTP_REQUIRED` with the username kept, and setup sends token + username + password. Verify with updated `components.test.tsx` cases for the two-step TOTP flow and setup, and check in the browser at 1440 px and 390 px (no horizontal scroll) in light and dark palettes.
- [x] 5.3 Add en and zh-CN strings for the sign-in page, brand tagline, `TOTP_REQUIRED`, `ROLE_FORBIDDEN`, `USERNAME_TAKEN`, `LAST_ADMIN` and `ADMIN_WITHOUT_TOTP`. Verify that the i18n catalog test passes with matching keys in both languages.

## 6. Role-aware console, Users view and Account settings

- [x] 6.1 Add a `useRole()` hook from `/me`. Show the username, role and a Read-only badge in the navigation; hide every mutating control for `user` (Add device, rotate/remove, client credential actions, disconnect, retention); refetch `/me` and show the localized message on `ROLE_FORBIDDEN`. Verify with a test that renders Devices, Clients and Settings as `user` and finds no mutating controls, and with the narrow-screen navigation test at 390 px for both roles.
- [x] 6.2 Add the admin-only Users view and route. `/console/users` falls back to Overview for viewers. The view has a list with role, TOTP, enabled, created and last sign-in; create, role change, disable/enable, reset password, remove TOTP; and delete with destructive styling and confirmation. Every action uses the re-authentication prompt. Verify with a view test covering create, the `LAST_ADMIN` message and the viewer redirect.
- [x] 6.3 Add an Account section to Settings for all roles: change password (current + new) and enable TOTP with a QR code, the secret and a one-time copyable display of the recovery codes, plus disable TOTP. Verify with a `settings.test.tsx` case for enrolment and the password change as a `user`.

## 7. Integration checks

- [x] 7.1 Run the full test suites (`npm test` for reach-rpc and gateway-console) and `openspec validate console-user-accounts --strict`, and verify everything passes.
- [x] 7.2 Upgrade check on a non-production host: start the previous release with `REACH_DATA_DIR` set and complete the old setup with TOTP. Then start this build on the same directory, sign in as `admin` with the old password and a code, create a `user`, sign in as them in another browser and confirm that view is read-only; finally run the offline reset and confirm the old sessions get 401. Record results only in ignored `.reach/` files.

## Workflow follow-up

- At archive, update the `gateway-admin-auth` Purpose in `openspec/specs/gateway-admin-auth/spec.md` from "single owner administrator account" to multiple console accounts with roles.
- Archive the change after review.
