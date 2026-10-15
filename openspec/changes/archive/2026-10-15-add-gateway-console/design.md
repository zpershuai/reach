# Design

## Context

See proposal.md for the motivation. These facts about the current code shape the approach:

- **Gateway composition.**
  - `createGateway` (`packages/reach-rpc/src/gateway.ts`) builds one `createEngineGateway` per Engine and keeps them in a fixed `Map`.
  - At the top level it routes `/mcp`, then selects an Engine by the `?engineId=` query or by matching the heartbeat Bearer token.
  - Engine tokens are compared in plain text with `timingSafeEqual`. A Gateway with several Engines must have authentication configured.
- **Session state and forwarding.**
  - Session state lives in memory in `EngineSessionState`. It has no change notifications.
  - All data-plane RPC, whether it arrives through REST `/session/rpc` or HTTP MCP through `InProcessGatewayClient` → `EngineApi.rpc`, passes through `SessionRpcForwarder.executeRpc`. That method is the single place where canonicalization, grant checks, deadlines and forwarding happen.
  - The forwarder does not know who the caller is.
- **HTTP MCP.** `createMcpHttpHandler` already validates `initialize.clientInfo` (`name` and `version`) but discards it after validation. It looks Engines up in the map it was given each time it handles a call.
- **Heartbeats.** The Engine currently sends `{"device":{"id","platform":"rust","engineVersion"}}`. The Gateway's heartbeat schema passes through unknown `device` fields.
- **Container.** The Gateway image is `node:24.21.0-alpine`. It runs with `read_only: true` and `cap_drop: ALL` as user `node`, and its only mounts are `engines.json` (read-only) and the update request directory. The private runtime shipped with Engine installs is also Node 24.21.0.
- **Build.** The runtime Gateway package depends only on `ws` and `zod`. `scripts/package-gateway.sh` ships `packages/reach-rpc/dist`.

## Goals / Non-Goals

**Goals:**
- One code path for Engine registration, whether or not storage is configured. Persistence is an optional layer underneath it.
- Audit and event hooks that are non-blocking and fail open for the data plane. A console bug must never change an RPC result.
- No new runtime npm dependency and no native addon in the Gateway image.
- A console safe to expose on the public origin with only Caddy TLS in front.

**Non-Goals:**
- Authenticated client identity. That arrives with OAuth in a follow-up change. Labels in this change are self-reported.
- Durable exactly-once audit. Audit records are best-effort while storage is healthy.
- Horizontal scaling. The Gateway remains a single process.

## Decisions

### D1. Console lives inside the Gateway process, routed before Engine selection
`createGateway` handles `/console/*` and `/api/console/*` at the same level as `/mcp`, before `selectGateway`. The code lives in a new `src/console-api/` module set:

| Module | Responsibility |
| --- | --- |
| `server.ts` | Router and JSON helpers. Reuses the 64 KiB body limit. |
| `auth.ts` | Administrator account, sessions, CSRF and Origin checks, rate limiter. |
| `store.ts` | SQLite access and migrations. |
| `events.ts` | Event bus and SSE fan-out. |
| `audit.ts` | Field allow-list, batching writer, query, export, retention. |
| `registry.ts` | Engine registry and enrollment. |
| `static.ts` | Asset serving and security headers. |

*Alternative considered:* a separate console service that talks to the Gateway. It was rejected because it needs a second privileged API, a second process to deploy, and duplicated state, which is the opposite of the single-control-plane model.

### D2. Storage: `node:sqlite` behind a small interface
- The database is `REACH_DATA_DIR/reach.db`, created with mode 0600, using `PRAGMA journal_mode=WAL` and `synchronous=NORMAL`.
- Schema versions are tracked with `PRAGMA user_version`, and migrations are forward-only.
- Tables: `admin`, `recovery_codes`, `console_sessions`, `engines`, `clients`, `activity`, `settings`.
- `activity` is indexed on `ts`, `(engine_id, ts)` and `(client_label, ts)`.
- No skill tables are created now. They will be added by the Skills change through a new migration.

*Alternatives considered:*
- `better-sqlite3`: it is a native addon, which would break the alpine, read-only and OpenWrt packaging story.
- JSON files: they offer no indexed query or retention and no atomic multi-record update.
- An external database: too heavy for a self-hosted product.

Node 24.21 ships `node:sqlite` without a flag, and both the image and the private runtime are pinned to that version.

### D3. Audit writes are batched off the request path
- Events are pushed to an in-memory queue, bounded at 10,000 entries, which drops the oldest entry and counts the drop.
- The queue is flushed in one transaction every 250 ms or every 200 rows.
- Flush errors set a `storageHealth` flag that the Overview reads (see the "Audit persistence never blocks forwarding" requirement).
- `DatabaseSync` is synchronous, but batched inserts of small rows take well under a millisecond, so the event loop stays responsive.

### D4. Event emission points
A typed `GatewayEvents` hub assigns each event a monotonically increasing id. It keeps a ring buffer of 2,000 events for SSE replay and isolates listeners, so a throwing listener is logged and the emitter continues.

| Hook | Events |
| --- | --- |
| `executeRpc` | `rpc.denied`: stage `route` when there is no ready session; stage `policy` when the request returns `PERMISSION_DENIED` before forwarding. |
| `executeRpc` | `rpc.started` immediately before `forwardToEngine`. |
| `executeRpc` | `rpc.finished` with the outcome after a reply, a timeout or a transport failure. |
| Engine WebSocket handler | Response byte size (`text.length`), recorded when the matching pending RPC resolves, so the payload is not serialized a second time. |
| `EngineSessionState` | `session.state`. The state takes an `onStatusChange` callback and a `notify()` helper. `notify()` runs after `openSession`, `requestClose`, the upgrade, ready, closed and the socket close, and compares the new value against the previous `sessionStatus().status`. |
| Heartbeat handler | `engine.heartbeat`, plus the update of the recorded hardware descriptor. |
| MCP HTTP handler | `client.connected` when a session is created; `client.disconnected` with reason `delete`, `idle`, `shutdown` or `console` when it is retired. |
| Top-level 401 paths | `auth.failed`, aggregated to at most one event per path and peer per 60 seconds, carrying a count, so scanners cannot flood the log. |
| Console API | `admin.action`. |

The audit field extraction is an allow-list function. It canonicalizes `tool.call` first, then copies only `workspace`, `path`, `script`, `processId` and `launchId`. A table-driven test asserts that no other parameter key ever reaches a record.

### D5. Caller context threads through existing APIs
- `executeRpc(body, receivedAt, caller?)`, `EngineApi.rpc(body, caller?)` and `EngineApi.open(sessionId, caller?)` gain an optional `CallerContext {type, label, verified:false, mcpSessionId?}`.
- **REST.** `/session/rpc` and `/session/open` derive the label from a sanitised `X-Reach-Client` header, falling back to `Controller API`.
- **HTTP MCP.** `RemoteMcpServer` receives its `clientInfo` label at construction and passes it to `InProcessGatewayClient`.
- **stdio.** `HttpGatewayClient` sends `X-Reach-Client: <clientInfo.name> <version> (stdio)` once its `McpProtocol` has seen `initialize`.
- **Ownership.** `EngineSessionState` remembers the opener's label as `ownerLabel`, so the topology can show which client holds each Engine.

*Alternative considered:* AsyncLocalStorage. It was rejected because the explicit parameter is easier to test and keeps the forwarder free of ambient state.

### D6. Registry replaces the fixed Engine map; token verification by digest
`EngineRegistry` owns a live `Map<engineId, {server, api, tokenDigest, origin}>`, and both `selectGateway` and `createMcpHttpHandler` read that live map.

**Token verification**
- `createEngineGateway` takes `verifyEngineToken(presented): boolean` instead of a plain-text token.
- Presented Bearer tokens are hashed with SHA-256 and compared with `timingSafeEqual` against each stored digest.
- Seeds are digested at startup, so behavior is identical whether or not storage is configured.
- The Controller token stays in the environment. It is never stored.

**Session endpoints**
- The default seed keeps the `/session` endpoint for compatibility.
- Every other Engine uses `/session?engineId=<id>`, as multi-Engine Gateways already do.

**Removal**
- Request close with reason `agent_requested`.
- Drop that Engine's `GrantStore`.
- Delete the Engine from the map, so later REST calls return 404 and MCP returns `Unknown device`.
- Keep its audit rows.

**Constraints**
- Enrollment requires `REACH_CONTROLLER_TOKEN`, which preserves the existing rule that multiple Engines need authentication.
- Seed entries cannot be removed or rotated from the console.

### D7. Administrator authentication without new dependencies
| Element | Implementation |
| --- | --- |
| Password | `scrypt` (N=2^15, r=8, p=1, 64-byte key, 16-byte salt) from `node:crypto`. |
| TOTP | RFC 6238, HMAC-SHA1, 6 digits, implemented in about 40 lines with test vectors from the RFC. The last accepted step is stored to block replay. |
| Recovery codes | 10 codes of 10 base32 characters each, stored as SHA-256 hashes. |
| Session id | 32 random bytes; only its SHA-256 is stored. |
| CSRF token | Random per session, returned by `GET /api/console/me` and required in `X-CSRF-Token`. |
| Rate limiting | In-memory token buckets per peer and one global bucket. |
| Setup token | `REACH_ADMIN_SETUP_TOKEN`, or 24 random bytes generated and logged once at startup, only while no administrator exists. |

**Peer resolution behind a proxy.** The client address comes from the socket peer unless that peer matches `REACH_TRUSTED_PROXIES` (IPs or CIDRs); only then is `X-Forwarded-For` used. In the shipped compose setup, Caddy reaches the container through docker-proxy, so the docs tell operators to set the bridge gateway address. If no trusted proxy is configured and every request comes from one private address, the Overview shows a warning that per-client limiting is degraded.

*Alternative considered:* passkeys (WebAuthn). They are the better user experience, but a correct verifier needs a dependency such as `@simplewebauthn/server`, and they are scoped as a follow-up change.

### D8. Console frontend: separate build package, static output
`packages/gateway-console` is a Vite + React + TypeScript project. All of these are devDependencies, and the build output goes to `packages/reach-rpc/dist/console`.

**Framework and fonts**
- No CSS framework is used. Light and dark design tokens follow the first approved prototype: a calm light surface, rounded cards, a three-stage pipeline card and line-art device glyphs tinted by session state.
- The fonts (Bricolage Grotesque, Geist and Geist Mono, all OFL) are self-hosted inside the bundle, so the CSP can stay `'self'`.
- Vite is configured with `base: '/console/'`. All resource loads stay local; inert library documentation, attribution and license URLs are permitted in bundled text. Check emitted HTML/CSS resource references and enforce the same-origin CSP instead of rewriting dependency bundles to erase URL strings.

**Topology rendering**
- The topology is a fixed three-lane DOM layout. SVG bezier links are computed from measured node positions; a canvas layer draws particles along them.
- A canvas overlay draws particles. It samples each edge's SVG path with `getPointAtLength` once per layout and caches the points.
- The overlay uses a single `requestAnimationFrame` loop, which also handles the aggregation of more than 20 events per second per link.

**App structure**
- State: one `useSyncExternalStore` store, seeded from `GET /api/console/snapshot` and advanced by an SSE reducer.
- Routing: a small in-house history router with no extra dependency.
- QR code for TOTP enrolment: rendered client-side by a small bundled encoder.

**Static serving**
- Hashed assets are served with `Cache-Control: immutable`.
- `index.html` is served with `no-cache`.
- Resolved paths must stay inside `dist/console`.
- Unknown `/console/*` paths return the index, so deep links work.

*Alternative considered:* @xyflow/react. It was dropped because the diagram has fixed lanes and needs no pan or zoom, and hand-measured links let particles stop exactly on each pipeline stage.

### D9. Console API surface
| Endpoint | Purpose |
| --- | --- |
| `POST setup`, `login`, `logout`, `reauth`; `GET me` | Administrator account and session |
| `GET snapshot` | Clients, Engines with effective hardware, Gateway info, KPIs |
| `GET events` | SSE stream with `Last-Event-ID` replay and a `: ping` comment every 15 s |
| `GET activity`, `GET activity/export?format=csv\|jsonl` | Cursor query and streamed export |
| `GET`/`POST engines`; `PATCH engines/:id`; `POST engines/:id/rotate`; `DELETE engines/:id` | Registry |
| `GET clients`; `POST clients/:label/disconnect` | Ingress clients |
| `GET`/`PATCH settings` | Retention, theme default, heartbeat display |

All endpoints are under `/api/console/`. SSE responses add `Cache-Control: no-cache` and `X-Accel-Buffering: no`. A subscriber is dropped when `writableLength` exceeds 1 MiB.

### D10. Engine hardware detection
A new `crates/reach-rpc/src/runtime/hardware.rs` runs once in `engine.rs`, before the Runtime starts. Its result is passed to `LocalHttpHeartbeatTransport` and serialized as `device.hardware`. It uses only std, with no new crates. Each child process is spawned with a 3-second deadline, enforced by a `try_wait` polling loop.

| Platform | Detection |
| --- | --- |
| macOS | `system_profiler SPHardwareDataType -json`. Reads only `machine_name` and `chip_type`. `machine_name` maps to `mac-mini`, `mac-studio`, `macbook`, `imac` or `mac`. The OS version comes from `sw_vers -productVersion`. The serial number and UUID fields are never read into the struct. |
| OpenWrt | `/etc/openwrt_release` gives kind `router`; the model comes from `/tmp/sysinfo/model` or `/proc/device-tree/model`. |
| Raspberry Pi | `/proc/device-tree/model` starting with `Raspberry Pi`. |
| NAS | Synology `/etc.defaults/VERSION`, or QNAP `/etc/config/uLinux.conf`. |
| Other Linux | DMI `product_name` and `chassis_type`. Chassis types 17, 23 and 28 map to `server`; anything else is `unknown`, with the product name kept as the model. |

All values are sanitized to printable characters and truncated to 64 characters on a character boundary.

### D10a. Readiness reports process execution configuration
`session.ready` gains an optional `processWorkspaces: string[]` containing the configured workspace names enabled for process execution. An empty list means execution is disabled everywhere; absence means an older Engine has not reported the setting. The Gateway retains this list alongside the existing workspace names and exposes it in console snapshots. Supported method names are not used to infer execution permission. Both Rust and TypeScript parsers accept older readiness messages without the field. Device details show each workspace's enabled/disabled setting, or "not reported" when the field is absent.

### D11. Deployment shape
- **Compose.** `deploy/compose.yaml` adds the `./data:/var/lib/reach:rw` volume and sets `REACH_DATA_DIR=/var/lib/reach` and `REACH_PUBLIC_ORIGIN` from `gateway.env`. The Gateway service keeps `read_only`, `cap_drop: ALL` and `no-new-privileges`.
- **Image.** `Dockerfile.gateway` creates `/var/lib/reach`, owned by `node`.
- **Release helper.** `apply-gateway-release.sh` preserves `data/`, just as it already preserves `gateway.env` and `engines.json`.
- **Caddy.** No change is required: SSE flushes automatically and the 64 KB body limit already matches.
- **Auto-update.** Idle detection ignores console sessions. A Gateway restart drops the SSE connections, and the console reconnects with `Last-Event-ID`.

## Risks / Trade-offs

- **`node:sqlite` may still emit an experimental warning or change behavior on Node upgrades.** → Node is pinned to 24.21 everywhere, access is wrapped behind `store.ts`, and the storage tests run in CI on Linux and macOS.
- **The administrator surface is now on the public origin.** → Mandatory TOTP, rate limiting, strict CSP, Origin and CSRF checks, re-authentication for sensitive actions, and an audit trail of administrator actions. The docs offer an optional Caddy IP allow-list or a Tailscale-only listener.
- **Self-reported client labels can be spoofed.** → They are shown as "unverified" and grant no privilege; they only label activity. Authenticated identity comes with OAuth.
- **Audit paths can reveal sensitive file names.** → Records are visible only to the owner, retention is bounded, and exports are themselves audited. Path redaction is listed as an open question.
- **Refactoring Engine token verification could regress authentication.** → The existing `gateway.test.ts` authentication cases are kept unchanged, and new tests prove that seeds from the environment and from `engines.json` authenticate exactly as before, with and without `REACH_DATA_DIR`.
- **Animation cost on busy Gateways.** → One canvas, per-link aggregation, a cap on edge sampling, a pause control and `prefers-reduced-motion` support.
- **A misconfigured trusted proxy can weaken rate limiting.** → Without `REACH_TRUSTED_PROXIES` the limiter keys on the socket peer, which degrades toward a global limit but is never spoofable, and the Overview shows a warning.

## Migration Plan

1. Release the Gateway with the console. Existing deployments see no change until `REACH_DATA_DIR` is set.
2. Operator steps:
   1. Create `deploy/data` owned by uid 1000 with mode 700.
   2. Add `REACH_DATA_DIR=/var/lib/reach` and `REACH_PUBLIC_ORIGIN=https://gateway.example.com` to `gateway.env`.
   3. Optionally add `REACH_TRUSTED_PROXIES`.
   4. Run `docker compose up -d`.
   5. Read the setup token from `docker compose logs gateway`.
   6. Open `/console/` and complete setup.
3. Existing environment and `engines.json` Engines appear as seeds. New devices can be enrolled from the console.
4. Release an Engine version that sends hardware descriptors. Older Engines keep working and show the generic glyph.
5. **Rollback.** Remove `REACH_DATA_DIR`, or redeploy the previous image. Previous Gateways ignore the data directory, and `engines.json` and the environment were never modified. Console-enrolled Engines stop authenticating under the old image. The rollback guide therefore tells operators to add those Engines to `engines.json` with newly issued tokens before downgrading.

## Open Questions

- Should audit paths support a redaction setting (full, hashed or none)? It can be added as a settings value without changing the event model.
- Which QR encoder should be used: a vendored minimal encoder, or the `qrcode-generator` devDependency? Either way it is bundled at build time.
- Should the topology group Engines by workspace when a device exposes many workspaces? This can be decided after real usage.
