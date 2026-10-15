# Proposal

## Why

Reach lets third-party bots (Grok Bot, ChatGPT, Hermes Agent and other MCP clients) operate the owner's private devices, but today the Gateway has no management surface. The owner cannot see which clients are connected, which devices are reachable, or what each bot did on each device, and devices can only be added by hand-editing `engines.json`. Trust and visibility are the core of a self-hosted remote-control product. A web console on the Gateway is the step that turns the project from a set of processes into an operable, professional open-source product.

## What Changes

- Add a **web console** served by the Gateway at `/console/` on the existing listener. It is a light-themed single-page app (React + Vite) with a routing-topology page as its centrepiece. The topology shows three lanes, ingress clients → the Gateway pipeline (auth → policy → route) → egress Engines. Particles in the topology are driven by real RPC events. The console also has Overview, Devices, Activity and Settings views, an add-device wizard, and a placeholder Skills view.
- Add a **single-owner administrator account**. The administrator is bootstrapped once with a setup token, then signs in with a password and a TOTP second factor. The session is an HttpOnly cookie. Login is rate-limited, state-changing requests are protected by an Origin check and a CSRF token, and a strict CSP applies. The console must be safe to expose on the public Gateway origin behind TLS.
- Add **persistent Gateway state** in SQLite under a new `REACH_DATA_DIR`, using `node:sqlite` with no new native dependency. It stores the administrator, console sessions, the Engine registry, observed ingress clients, the activity audit log and settings. Without `REACH_DATA_DIR` the Gateway behaves as today and the console is disabled.
- Add a **dynamic Engine registry**:
  - Engines can be added from the console. The console generates a token, shows it once, and stores only its SHA-256 digest. It then shows per-platform install commands and live wait-for-first-heartbeat feedback.
  - Engines can be renamed, have their token rotated, have their device type overridden, and be removed.
  - The existing `REACH_ENGINE_*` environment variables and `REACH_ENGINES_FILE` continue to work as declarative seeds, and existing deployments keep working unchanged.
- Add an **activity audit and live event stream**:
  - The forwarding pipeline emits structured, metadata-only events: RPC start and finish, policy denials, session state changes, heartbeats, MCP client connect and disconnect, and administrator actions.
  - The console receives these events over Server-Sent Events.
  - RPC events are persisted with configurable retention (default 30 days) and can be exported as CSV or JSONL.
  - File contents, written bodies and process output are never recorded.
- Add **ingress attribution**:
  - HTTP MCP sessions are labelled by their `initialize` `clientInfo`.
  - Controller REST callers are labelled by an optional `X-Reach-Client` header. The stdio connector sends this header, labelled with its own MCP client's name.
  - All of these labels are self-reported and are shown as such until authenticated client identity arrives with OAuth.
- The **Engine reports a hardware descriptor** in its heartbeat: device kind, model, OS, OS version and architecture, detected once at startup. The console uses it to render recognisable device glyphs, such as a Mac mini, an OpenWrt router, a NAS or a Raspberry Pi. The Gateway accepts heartbeats without the descriptor, so older Engines keep working.
- The Engine optionally reports `processWorkspaces` in `session.ready`, listing workspaces where process execution is enabled. The console displays that configuration without inferring it from supported methods; older Engines show "not reported".
- Update the compose deployment and docs: add a data volume for `REACH_DATA_DIR`, add console environment variables, and add reverse-proxy guidance. The Gateway container stays `read_only` with no added capabilities.

Non-goals for this change, each planned as its own follow-up change:
- MCP OAuth 2.1 authorization server and per-client authorization scopes.
- The Skill framework: a catalogue, Engine `skill.*` methods, and MCP skill exposure. This change only reserves the console navigation entry and an informational device-detail section.
- Passkey login.
- Multi-user or multi-tenant administration.

## Capabilities

### New Capabilities
- `gateway-console`: The Gateway-hosted web console. Covers static asset serving and CSP, the topology view and its event semantics, the Overview, Devices, Activity and Settings views, the add-device wizard, the device-type glyphs, and the reserved Skills entry.
- `gateway-admin-auth`: The single-owner administrator account. Covers setup bootstrap, password plus TOTP sign-in, console sessions, CSRF and Origin protection, login rate limiting, and the separation of console credentials from Controller and Engine tokens.
- `gateway-activity-audit`: The event bus, Server-Sent Events stream, metadata-only audit records, ingress attribution, retention and export.
- `gateway-engine-registry`: Persistent Engine registration. Covers hashed tokens, seeding from environment variables and `engines.json`, runtime add, rename, rotate, override and remove, and the persisted device hardware descriptor.

### Modified Capabilities
- `gateway-heartbeat`: The heartbeat endpoint accepts and records an optional bounded `device.hardware` descriptor, and rejects nothing because of it.
- `edge-engine-service`: The resident Engine includes a hardware descriptor, detected once at startup, in each heartbeat.
- `mcp-streamable-http`: HTTP MCP sessions carry their `clientInfo` as an ingress attribution label for audit and console display, and can be retired from the console.

## Impact

- **Gateway (`packages/reach-rpc`)**:
  - `gateway.ts` gains top-level `/console/` and `/api/console/*` routing ahead of Engine selection, alongside `/mcp`.
  - The per-Engine map becomes mutable at runtime.
  - `SessionRpcForwarder.executeRpc` and `EngineApi.rpc` accept a caller context.
  - `EngineSessionState` emits state-change events.
  - New modules: storage, admin auth, event bus and SSE, audit, and registry. Readiness state retains workspace names and optional `processWorkspaces` for device details.
  - `gateway-main.ts` parses new environment variables: `REACH_DATA_DIR`, `REACH_PUBLIC_ORIGIN`, `REACH_ADMIN_SETUP_TOKEN`, `REACH_TRUSTED_PROXIES` and `REACH_AUDIT_RETENTION_DAYS`.
- **New package `packages/gateway-console`**: React and Vite as development-time dependencies only. The built assets are copied into `packages/reach-rpc/dist/console`, so the runtime Gateway image gains no new npm runtime dependency.
- **Engine (`crates/reach-rpc`)**: a hardware detection module, an added heartbeat payload field, and an optional `processWorkspaces` readiness field. No new crates.
- **stdio connector**: `HttpGatewayClient` sends `X-Reach-Client`.
- **Deployment**: `deploy/compose.yaml` adds a writable data volume. `deploy/Dockerfile.gateway` creates `/var/lib/reach`. `scripts/package-gateway.sh` and `scripts/verify.sh` build and test the console.
- **Docs**: `docs/deploy/gateway.md` and `docs/deploy/configuration.md` gain a new console guide and a security guide for public exposure. Examples use reserved domains only.
- **Compatibility**: existing REST and MCP behavior is preserved. Engine heartbeat hardware and readiness `processWorkspaces` are optional additive fields; older peers keep working.
