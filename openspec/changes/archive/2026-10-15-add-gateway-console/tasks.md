# Tasks

## 1. Gateway storage foundation

- [x] 1.1 Add `src/console-api/store.ts` wrapping `node:sqlite` (WAL, mode 0600 `reach.db`, `PRAGMA user_version` migrations creating `admin`, `recovery_codes`, `console_sessions`, `engines`, `clients`, `activity`, `settings` with the D2 indexes); verify a node test opens a temp dir twice, migrations are idempotent, and the file mode is 0600.
- [x] 1.2 Parse `REACH_DATA_DIR`, `REACH_PUBLIC_ORIGIN`, `REACH_ADMIN_SETUP_TOKEN`, `REACH_TRUSTED_PROXIES` and `REACH_AUDIT_RETENTION_DAYS` in `gateway-main.ts`. Fail before listen if the data dir is unwritable, if retention is outside 1–365, or if a non-loopback bind has a data dir but no public origin. Verify tests cover each failure, and that an unset `REACH_DATA_DIR` leaves `GET /console/` at 404 with all existing `gateway.test.ts` cases passing.
- [x] 1.3 Document the new variables in `docs/deploy/configuration.md`, using reserved example domains only; verify `rg -n "example\.com|REACH_DATA_DIR" docs/deploy/configuration.md` shows the entries and no real hostnames.

## 2. Engine registry and digest authentication

- [x] 2.1 Introduce `EngineRegistry` with a live engine map and SHA-256 token digests. Change `createEngineGateway` to take a `verifyEngineToken` function. Keep `/session` for the default seed and `?engineId=` for every other Engine. Verify the existing multi-Engine and authentication tests pass unchanged, and add a test showing `engines.json` and environment seeds authenticate with and without `REACH_DATA_DIR`.
- [x] 2.2 Persist and upsert seeds at startup, updating the digest when a seed token changes. Store the Engine's origin (`seed` or `console`), display name, override and last hardware. Verify a restart test keeps a console-added Engine and its token working.
- [x] 2.3 Implement add, rename, override, rotate and remove. Ids must match `[A-Za-z0-9._-]{1,64}`. Generated tokens carry 256 bits of randomness and are returned once. Seeds refuse remove and rotate with 409. Enrollment is refused without a Controller token. Removal closes the session with `agent_requested`, drops grants and keeps audit rows. Verify the following with tests:
  - an enrolled Engine heartbeats and appears in MCP `list_devices` without a restart;
  - after rotation the old token returns 401;
  - after removal the Engine's REST calls return 404 and MCP reports `Unknown device`.
- [x] 2.4 Track enrollment status (`awaiting_heartbeat` until the first authenticated heartbeat, then `connected`); verify a test observes the transition.

## 3. Event bus, caller attribution and audit

- [x] 3.1 Add the `GatewayEvents` hub (monotonic ids, 2,000-event ring buffer, listener isolation); verify a test where one listener throws and the other listeners still receive the event.
- [x] 3.2 Thread `CallerContext` through `executeRpc`, `EngineApi.rpc`, `EngineApi.open` and `InProcessGatewayClient`. Sanitise `X-Reach-Client` to at most 64 printable characters, falling back to `Controller API`. Make `RemoteMcpServer` keep the `clientInfo` label. Store `ownerLabel` on the session state. Verify tests for the label sources and the fallback, and confirm all existing MCP tests pass.
- [x] 3.3 Emit the following events, per the D4 hook table:
  - `rpc.started`, `rpc.finished` (with outcome, code, latency and response bytes captured from the WebSocket text length) and `rpc.denied` (stage `policy` or `route`);
  - `session.state`, through `onStatusChange` and `notify()`, deduplicated;
  - `engine.heartbeat`, `client.connected` and `client.disconnected` (with a reason);
  - `auth.failed`, aggregated per path and peer per 60 seconds.

  Verify gateway tests for each event, including a write without a grant that produces `rpc.denied`/`policy` with no forward, and confirm that RPC results are byte-identical with the hub enabled and disabled.
- [x] 3.4 Implement the audit field allow-list (canonicalize `tool.call` first; keep only `workspace`, `path`, `script`, `processId` and `launchId`); verify a table-driven test showing `content`, `oldString`, `newString`, `pattern`, `args`, tokens and grant ids never reach a record.
- [x] 3.5 Add the batched audit writer (10,000-entry bounded queue, flush every 250 ms or 200 rows, `storageHealth` flag); verify a test where an injected write failure leaves RPC results unchanged and flags the health warning.
- [x] 3.6 Add the activity query (newest first, cursor, filters for time, Engine, client, method class and outcome), streamed CSV and JSONL export with dated filenames and an `admin.action` record, and a daily retention prune; verify tests for the filters, CSV quoting, JSONL lines and pruning of 31-day-old rows at 30-day retention.

## 4. Administrator authentication

- [x] 4.1 Implement scrypt password hashing, RFC 6238 TOTP with replay protection, and hashed recovery codes; verify the RFC 6238 test vectors pass, a replayed code is rejected and a recovery code is consumed after use.
- [x] 4.2 Implement setup through the env or logged setup token, plus login, logout, re-authentication and `me`. Use the cookie attributes from the spec (`Secure` when the public origin is HTTPS), 12 h idle and 7 day absolute expiry, and hashed session ids. Verify the following with tests:
  - a wrong token returns 403;
  - a second setup returns 409;
  - a wrong password and a wrong TOTP code return identical errors;
  - after sign-out, the old cookie returns 401;
  - an idle session expires.
- [x] 4.3 Add CSRF header and Origin enforcement on state-changing routes, a 10-minute re-authentication gate for sensitive actions, and peer resolution through `REACH_TRUSTED_PROXIES` for the per-peer and global rate limiter (429 with back-off). Verify tests for a foreign Origin, a missing CSRF header, a stale session removing an Engine (403), a spoofed `X-Forwarded-For` from an untrusted peer, and 429 after 5 failures.
- [x] 4.4 Verify credential isolation: the Controller token on `/api/console/*` returns 401, and a console cookie on `/session/rpc` is rejected as unauthenticated. Record login, logout, failed attempts and administrator changes as `admin.action` or `auth.failed`; verify with tests.

## 5. Console API and static serving

- [x] 5.1 Add the D9 routes under `/api/console/`, routed before Engine selection: snapshot, activity and export, engines, clients with disconnect (retiring HTTP MCP sessions by label through the DELETE path and recording `admin.action`), and settings. Verify an integration test that drives a real Engine (via the existing integration harness) and sees snapshot data, plus a disconnect test where the old `Mcp-Session-Id` receives 404.
- [x] 5.2 Add the SSE stream: `Last-Event-ID` replay, `: ping` every 15 s, `no-cache` and `X-Accel-Buffering: no` headers, a 1 MiB backpressure drop, and 401 without a session. Verify tests for in-order replay of 4181–4200, for a stalled subscriber being dropped without affecting RPC latency, and for 401.
- [x] 5.3 Add static serving from `dist/console`: CSP and security headers, immutable hashed assets, a `no-cache` index, deep-link fallback, path-traversal guard, and 503 when the assets are absent. Verify tests that check the headers, that `/console/devices/nas-01` returns the index, that `/console/../package.json` is refused, and that a build without assets returns 503.

## 6. Engine hardware descriptor

- [x] 6.1 Add `runtime/hardware.rs` implementing the D10 sources (macOS `system_profiler` with a 3-second deadline, OpenWrt, Raspberry Pi, Synology and QNAP, DMI), sanitized and truncated to 64 characters. Read no serial number, hostname or MAC. Verify unit tests that use fixture files and fake command output for each platform, plus truncation and the `unknown` fallback.
- [x] 6.2 Detect the hardware once in `engine.rs` and send it as `device.hardware` in `LocalHttpHeartbeatTransport`; verify the existing heartbeat payload test is extended to assert the five fields, and that `cargo test --workspace --locked` passes.
- [x] 6.3 In the Gateway, validate the descriptor with zod (each field at most 64 printable characters, unknown kind treated as `unknown`, invalid input ignored), record it in the registry and include it in snapshots and `engine.heartbeat` events; verify tests for a valid descriptor, a 500-character model being ignored with the previous value kept, and a heartbeat without a descriptor.
- [x] 6.4 Document hardware reporting and the device-type override in `docs/deploy/engine.md`; verify the doc lists the reported fields and states that no serial or network identifiers are sent.
- [x] 6.5 Add optional `processWorkspaces` to Rust and TypeScript `session.ready`, report the Engine's configured execution workspaces (including an empty list when disabled), retain it with workspace names in Gateway readiness state and console snapshots, and show per-workspace enabled/disabled or "not reported" for older Engines in device details. Verify protocol compatibility and enabled, disabled and absent-field cases in Rust, Gateway and console tests.

## 7. Console frontend

- [x] 7.1 Scaffold `packages/gateway-console` (Vite with `base: '/console/'`, React, TypeScript, vitest; self-hosted OFL fonts that are never inlined as data URLs; light and dark design tokens from the approved prototype), building into `packages/reach-rpc/dist/console`; verify `npm --prefix packages/gateway-console run build` writes `index.html` and hashed assets, and that HTML/CSS resource references resolve locally under `/console/` (or use data URLs). Permit inert bundled library documentation, attribution and license URLs; do not rewrite dependency bundles. Verify the build resource check and same-origin CSP tests.
- [x] 7.2 Implement the snapshot plus SSE store (reducer, `Last-Event-ID` reconnect) and the in-house router; verify vitest reducer tests for every event type and for reconnect-replay deduplication.
- [x] 7.3 Implement the setup and sign-in screens: TOTP enrolment with a bundled QR encoder, recovery codes shown once, and a re-authentication prompt for sensitive actions; verify vitest component tests, and confirm the token and recovery codes are never written to `localStorage` or `sessionStorage`.
- [x] 7.4 Implement the Topology view to the spec:
  - three lanes and the Gateway stage pipeline;
  - link-state encoding;
  - the event-driven canvas particle layer, with per-link aggregation above 20 events per second;
  - the reduced-motion fallback;
  - linked filtering, the detail drawer and the activity table.

  Verify vitest tests for the particle scheduler (stage timing, denial stopping at policy, aggregation) and the link-state mapping.
- [x] 7.5 Implement the device glyph set (`mac-mini`, `mac-studio`, `macbook`, `imac`, `mac`, `router`, `nas`, `raspberry-pi`, `server`, with `unknown` mapped to `server`) with a state-driven status LED and override precedence; verify vitest tests for the glyph selection and override cases.
- [ ] 7.6 Implement the Overview (KPIs, versions and update status, storage and security warnings), the Devices view with the add-device wizard (one-time token, per-platform install commands from the public origin, live wait for the first heartbeat, the rename/override/rotate/remove actions), the Clients view (unverified labels, disconnect), the Activity view (filters and export links), Settings (retention, theme) and the reserved Skills view; verify the vitest view tests and a manual run against a local Gateway and Engine following the dev instructions in `packages/gateway-console/README.md`, written as part of this task.

Task 7.6: implementation and automated view tests are complete. Manual browser verification is deferred at the user's request; keep the task unchecked until that check is performed.

## 8. Packaging, deployment and docs

- [x] 8.1 Make `scripts/package-gateway.sh` build the console before `docker build`, and make `scripts/verify.sh` run `npm --prefix packages/gateway-console ci --ignore-scripts && npm --prefix packages/gateway-console test`; verify that `bash scripts/verify.sh` passes locally and that the Gateway image contains `dist/console/index.html`.
- [x] 8.2 Update `deploy/compose.yaml` (data volume, `REACH_DATA_DIR`) and `deploy/Dockerfile.gateway` (`/var/lib/reach` owned by `node`), keeping `read_only`, `cap_drop: ALL` and `no-new-privileges`, and make `scripts/apply-gateway-release.sh` preserve `data/`; verify that the existing compose assertions and fake-docker helper tests pass with a new assertion that `data/` survives an apply.
- [x] 8.3 Make the stdio connector's `HttpGatewayClient` send `X-Reach-Client: <clientInfo> (stdio)`; verify a connector test asserts the header after `initialize`.
- [x] 8.4 Write `docs/deploy/console.md` covering enabling the console, first-time setup from the logged token, reverse-proxy and `REACH_TRUSTED_PROXIES` guidance, an optional IP allow-list, enrollment, and backup, restore and rollback of the data directory. Link it from `docs/deploy/README.md` and the README. Verify that `scripts/verify-packaging.sh` still passes and that the doc's commands use example domains only.

## 9. Integration check

- [x] 9.1 Run an end-to-end test on a local loopback Gateway with `REACH_DATA_DIR`:
  1. Complete setup.
  2. Enroll an Engine.
  3. Start a real Engine and observe the first heartbeat with its hardware.
  4. Drive an HTTP MCP client through `fs_read`, a denied `fs_write` and an allowed `fs_write`.
  5. Assert that the SSE stream and the audit store show the matching `rpc.*` events with the `clientInfo` label and no written content.
  6. Export CSV.
  7. Disconnect the client.

  Verify the scenario runs in `npm --prefix packages/reach-rpc test`, and that `openspec validate add-gateway-console --strict` passes.

## Workflow follow-up

- Plan the follow-up changes: MCP OAuth 2.1 with per-client scopes, the Skill framework (catalogue, Engine `skill.*` methods, MCP skill exposure, console Skills view), and passkey login.
- After deploying the console to your own Gateway, archive this change once review is complete.
