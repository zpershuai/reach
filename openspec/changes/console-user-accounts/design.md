# Design

## Context

The console API lives in `packages/reach-rpc/src/console-api/` and stores its state in SQLite (`reach.db` under `REACH_DATA_DIR`, opened through `node:sqlite`). Schema changes are an ordered `migrations` array tracked by `PRAGMA user_version`. A Gateway refuses to open a database that is newer than it knows.

Today's model is hard-wired to one account:
- `admin` has `CHECK (id = 1)`, and `recovery_codes` and `console_sessions` reference `admin(id)`.
- `ConsoleAuth` handles `me`, `setup`, `login`, `logout` and `reauth`.
- `AdminCredentials.acceptFactor` validates TOTP and recovery codes against row 1.
- `ConsoleServer.handle` derives `mutation` and `recent` per route and calls `auth.require`.
- `OAuthServer` calls `auth.verifyOwner(password, code)` for `/oauth/authorize`.
- `auth.action()` emits `admin.action` with the fixed label `Administrator`.

The console SPA's `Auth.tsx` renders setup and login in one centered card, with `qrcode-generator` already bundled. CSP is `default-src 'self'` with no third-party assets.

## Goals / Non-Goals

**Goals:**
- One account model that serves sign-in, re-authentication, OAuth approval and the CLI. All four share the same rate limiter and the same generic-error behaviour.
- Enforce roles centrally on the server, so a new route is admin-only unless it says otherwise.
- Upgrade without user action beyond typing `admin` as the username.

**Non-Goals:**
- Fine-grained permissions such as per-Engine viewers or custom roles. There are exactly two roles.
- Federated or external login (OIDC, LDAP, Google sign-in), email invitations and self-registration.
- Per-user data scoping. Every role sees the same Gateway state.
- Making OAuth-approved MCP clients belong to a user. Grants stay Gateway-wide; only the approver is audited.

## Decisions

### D1. Data model: a new `users` table, with `admin` migrated into it
Append one migration to the `migrations` array. In a single transaction it:
1. Creates `users` with these columns: `id INTEGER PRIMARY KEY`, `username TEXT NOT NULL`, `username_key TEXT NOT NULL UNIQUE` (lower-cased), `password_hash`, `role TEXT CHECK (role IN ('admin','user'))`, `totp_secret TEXT NULL`, `last_totp_step INTEGER NOT NULL DEFAULT -1`, `disabled INTEGER NOT NULL DEFAULT 0`, `created_at`, `last_login_at NULL`, and `password_changed_at`.
2. Copies `admin` row 1 into `users` as `(1, 'admin', 'admin', …)`, keeping its hash, TOTP secret and step.
3. Rebuilds `recovery_codes` as `(digest, user_id → users ON DELETE CASCADE)` and copies the existing codes.
4. Drops and recreates `console_sessions` with `user_id → users ON DELETE CASCADE`. Old sessions are discarded, which is simpler than rewriting the foreign key. The cost is one sign-in after upgrade.
5. Drops `admin`.

Because the migration runs inside the existing `user_version` mechanism, it runs exactly once and an older Gateway refuses the upgraded database. That is acceptable, and it is noted in the Migration Plan.

*Alternative considered:* keep `admin` and add a `users` table beside it. Rejected: it leaves two sources of truth for the first admin.

### D2. A single credential check: `verifyAccount`
`ConsoleAuth` gains one private method: `verifyAccount(peer, username, password, code?) → user | 'totp_required' | fail`. Login, OAuth approval and (with password only) re-authentication all go through it. The method:
- Looks up the user by `username_key`.
- Always runs `verifyPassword`. When the user is unknown, it verifies against a fixed dummy scrypt hash so the timing stays comparable.
- Treats a disabled account as failure.
- For a TOTP account, returns `totp_required` when no code is given and the password was right. Otherwise it calls `acceptFactor(userId, code)`.

Only `fail` bumps the rate limiter and emits `auth.failed`; `totp_required` does neither. `verifyOwner` is replaced by `verifyAccount` plus a role check, and a `user`-role account is reported to the OAuth page as the generic failure.

*Alternative considered:* a stateful two-step flow, where the password step stores a pending challenge on the bootstrap cookie. Rejected for now: resubmitting username, password and code is stateless and matches how the existing single-request login works. The console keeps the password in memory between the two steps and never persists it.

### D3. Role enforcement: deny by default in `ConsoleServer.handle`
`auth.require(request, { mutation, recent, role })` returns `{ session, user }` with the user's current role and disabled state, read on every request. That read is already a DB hit for the session row, so a JOIN costs almost nothing. `ConsoleServer.handle` computes `role = mutation && !SELF_SERVICE.has(route) ? 'admin' : 'any'`, so every mutation needs `admin` unless its route is allow-listed. The allow-list covers:
- `account/password`
- `account/totp*`
- the theme and language keys of `settings`

`settings` is split: when a `PATCH` touches only `theme` it is self-service. `retentionDays` keeps requiring an admin plus recent re-authentication.

### D4. User-management API
The routes live under `/api/console/users`, all admin-only and with recent re-authentication on every mutation:
- `GET /users`
- `POST /users {username, password, role}`
- `PATCH /users/:id {role?, disabled?}`
- `POST /users/:id/password {password}`
- `DELETE /users/:id/totp`
- `DELETE /users/:id`

The last-admin rule is checked inside the same transaction as the write, so two admins demoting each other at once cannot both succeed: `SELECT count(*) FROM users WHERE role='admin' AND disabled=0 AND id != ?`. Session revocation is a `DELETE FROM console_sessions WHERE user_id=?` in the same transaction.

Self-service routes:
- `POST /account/password {current, password}`
- `POST /account/totp/begin`, which returns the secret and otpauth URL. The secret is held server-side on the session row (a `pending_totp_secret` column) for 10 minutes.
- `POST /account/totp/confirm {code}`, which returns the recovery codes.
- `DELETE /account/totp` (requires recent re-authentication).

### D5. Simplified setup
`POST /setup {token, username, password}` creates user 1 as `admin` without TOTP and signs the owner in. The old two-call flow is removed: first token only to get a secret, then password and code. The token handling (`loadSetupToken`, `removeSetupToken`, digest comparison, leftover-file warning) is unchanged. "Admin exists" becomes "any user exists".

### D6. Offline reset in `gateway-main.ts`
`reach-gateway admin reset-password <username>` is dispatched before the server starts. It:
- Opens the `ConsoleStore` directly (which runs pending migrations).
- Reads the password with echo disabled on a TTY, or one line from stdin when stdin is not a TTY, so automation can pipe it in.
- Asks for confirmation on a TTY only.
- Sets the hash, clears TOTP and recovery codes, sets `disabled=0`, deletes the user's sessions, and inserts an `admin.action` activity row labelled `Host CLI`.

SQLite WAL makes this safe while the Gateway is running. The running process sees the revoked sessions on the next request, because it reads sessions from the DB.

It is a subcommand of the existing binary rather than a separate script, so packaged installs (systemd, Docker) can run it the same way as the server, e.g. `docker exec … reach-gateway admin reset-password admin`.

### D7. Audit attribution
`auth.action(action, actor)` takes `{ type: 'console', label: username, verified: true }`. Setup uses the label `Setup` and the CLI uses `Host CLI`. Targets are appended to the action string in the existing `verb:id` style, for example `user.disable:ops`. Usernames are not secrets, so storing them is consistent with the metadata-only audit.

### D8. Sign-in page and brand visual
- `Auth.tsx` is rewritten as `AuthLayout` (a CSS grid: `minmax(0, 1.4fr) minmax(360px, 1fr)` at ≥960 px, stacked below) with `SignInForm` and `SetupForm`.
- The left panel is a new `BrandVisual` component: a hand-drawn inline SVG of three columns (bot glyphs → Gateway pipeline → device glyphs) that reuses the existing `Glyph` icons and the topology colour tokens.
- Particles are CSS `offset-path` animations on fixed paths, driven by no data and no timers in JS. That keeps the page cheap and gives `prefers-reduced-motion: reduce` a single CSS switch.
- Bots are generic chat or agent glyphs, never vendor logos.
- The SVG is `aria-hidden`, and the panel's text (product name and tagline) is real text for screen readers and i18n.
- Below 960 px the panel becomes a 160 px banner showing the name and a cropped, static strip of the topology.

*Alternative considered:* reuse the live xyflow topology with fake nodes. Rejected: it pulls the heavy graph bundle into the sign-in route and risks rendering real names by mistake.

### D9. Role-aware SPA
`/me` returns `user: {id, username, role, totpEnabled}`. A `useRole()` hook gates controls. Mutating buttons are not rendered for viewers (rather than disabled) to keep views clean, and a "Read-only" badge appears next to the username. A `ROLE_FORBIDDEN` response triggers a `/me` refetch so the controls match the server.

## Risks / Trade-offs

- [Password-only sign-in on a public console is weaker than mandatory TOTP] → TOTP stays available per user. The Users view shows each account's TOTP status. A snapshot warning `ADMIN_WITHOUT_TOTP` (localized, additive per the stable-warning-code rule) is shown while any enabled admin has TOTP off. Rate limits and the 12-character minimum are unchanged.
- [`TOTP_REQUIRED` tells an attacker the password is right] → The attacker still needs the second factor. The response is only produced for correct passwords, which are the expensive part to guess and are already rate limited. This matches common practice.
- [The console scripts `/api/console/login` without `username`] → A request without `username` is rejected as invalid credentials. The change is noted in the release notes, and the console is the only first-party client.
- [An older Gateway refuses the migrated DB on rollback] → Back up `reach.db` before upgrading (see the Migration Plan). The existing "database is newer" diagnostic already tells the operator what to do.
- [A forgotten shared admin password becomes a host-access problem] → This is intentional: the offline reset needs shell access to the data directory, which is the same trust level as reading `admin-setup-token` today.
- [The deny-by-default role check could block a route that should be self-service] → An explicit allow-list plus a test that walks every mutating console route as a `user` and expects 403 except for the allow-listed ones.

## Migration Plan

1. Before upgrading, the operator copies `REACH_DATA_DIR/reach.db` (documented in the release notes and docs).
2. On first start, the new Gateway runs the D1 migration in one transaction. A failure rolls back and stops startup with the existing migration diagnostic.
3. The owner signs in with username `admin`, their existing password and an authenticator code, as before. They can then rename nothing, add users, or turn their TOTP off in Account settings.
4. Rollback: stop the new Gateway, restore the backup copy of `reach.db`, then start the previous version. Changes made after the upgrade are lost.

## Open Questions

- Should usernames be renamable later? This is not required now; the `username_key` design allows adding it without schema change.
