# Proposal

## Why

The console allows exactly one administrator (`admin.id = 1`). Every sign-in needs a password plus a mandatory authenticator-app TOTP code, and first-run setup needs a setup token, a QR enrolment and ten recovery codes. That is heavy for the common self-hosted case. It also makes it impossible to give a teammate a view of the Gateway without handing over full control of every enrolled device. The sign-in page is a bare centered card that says nothing about what Reach is.

## What Changes

- Replace the single-row `admin` table with a database-managed `users` table: unique username, password hash, role (`admin` or `user`), optional TOTP secret, disabled flag and timestamps. Console sessions belong to a user.
- **BREAKING (API)**: `POST /api/console/login` and `/setup` take `username` and `password`. TOTP becomes a per-user opt-in: a user with TOTP enabled receives a second-step challenge, and everyone else signs in with username and password. `/api/console/me` returns `{ user: { id, username, role, totpEnabled } }` in place of `admin: { id: 1 }`.
- Simplify first-run setup to setup token + admin username + password. Drop forced QR enrolment and up-front recovery codes. Recovery codes are issued only when a user enables TOTP.
- Add roles:
  - `admin` has today's full authority plus user management.
  - `user` is read-only: Overview, Topology, Devices, Clients and Activity can be viewed, and every mutation returns 403 `ROLE_FORBIDDEN`.
  - Some per-user actions stay open to everyone, including `user`: changing their own password, managing their own TOTP, choosing a theme or language, and signing out.
- Add admin-only user management APIs and a console Users view: create a user, change role, disable or enable, reset a password, remove TOTP, delete. These actions need recent re-authentication. The last enabled admin can never be removed, demoted or disabled.
- Add an offline recovery command on the Gateway host: `reach-gateway admin reset-password <username>`. It sets a new password, clears TOTP and revokes that user's sessions. This replaces "lost every factor = reinstall".
- MCP OAuth approval: an enabled `admin` user approves with their username, password and, if they have enabled it, their TOTP code. `user` accounts cannot approve.
- Console audit events name the acting user (`console` type, label = username) instead of the fixed `Administrator`.
- Redesign the sign-in and setup pages as a split layout:
  - Left: a decorative brand panel with an animated mini topology (bots → Gateway → devices) that uses no live data.
  - Right: the form.
  - On narrow screens the visual collapses to a top banner.
- Migration: an existing `admin` row becomes user 1 with username `admin` and role `admin`. Its TOTP secret, replay step and recovery codes carry over, so TOTP stays enabled for that account. Existing installations keep signing in. Only the username field is new.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `gateway-admin-auth`:
  - Single owner becomes multiple database accounts with `admin` and `user` roles.
  - Mandatory TOTP becomes optional per-user TOTP, and setup is simplified.
  - Adds user management, role enforcement, the offline password reset, and migration of the existing administrator.
- `mcp-oauth`: owner approval becomes approval by an enabled admin user, with TOTP only when that user enabled it.
- `gateway-activity-audit`: console attribution names the acting user.
- `gateway-console`:
  - Adds the split-layout sign-in and setup page and the Users view.
  - Makes the UI role-aware: read-only users see no mutating controls.
  - Adds self-service account settings (password, TOTP).

## Impact

- **Gateway**:
  - `packages/reach-rpc/src/console-api/`: `store.ts` (migration), `credentials.ts`, `auth.ts`, `server.ts` (role guard), `oauth.ts` and the OAuth messages, `events.ts`, plus new user-management routes.
  - `gateway-main.ts`: the `admin reset-password` subcommand.
- **Console**: `packages/gateway-console/src/`:
  - `Auth.tsx` is rewritten, and a new brand visual component is added.
  - `App.tsx` and the views hide mutations for the `user` role.
  - Adds a Users view and account settings.
  - `i18n` catalogs (en and zh-CN).
- **API clients**: anything scripting `/api/console/login` must send `username`. The console is the only first-party client.
- **Docs**: deployment and admin docs (README, `docs/`) for setup, roles and password reset, kept generic per AGENTS.md.
- **No change** to data-plane credentials, controller/Engine tokens, CSRF/Origin checks, cookie format, session lifetimes or rate limits.
