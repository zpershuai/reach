## Context

The Reach Gateway already owns Engine session lifecycle and grants, while its Engine executes `fs.*` against configured workspace roots. It has no MCP endpoint and is intentionally unaware of Grok-specific APIs. See `proposal.md` for the motivation and `specs/grok-bot-mcp-connector/spec.md` for the observable contract.

## Goals / Non-Goals

**Goals:**

- Deliver a small standalone stdio MCP server that binds ordinary filesystem calls to one picked Reach device.
- Make the default loopback Gateway useful immediately while allowing an operator-supplied device list.
- Demonstrate the dynamic `tools/list` refresh behavior in an automated client proof.
- Preserve the Gateway as the sole session and grant authority.

**Non-Goals:**

- Implement device discovery, a Gateway device registry, remote authentication, or multiple simultaneously selected devices.
- Add a native Grok SDK, `registerTool` call, or any host-filesystem execution path.
- Change Gateway or Engine session/authorization contracts.

## Decisions

### 1. Use a dependency-free JSON-RPC stdio MCP transport

The new `packages/grok-bot-mcp-connector` package will parse one newline-delimited JSON-RPC message at a time from standard input and write JSON-RPC responses or notifications to standard output. It implements only the MCP methods needed by this connector: `initialize`, `notifications/initialized`, `tools/list`, and `tools/call`.

**Why:** the repository already uses TypeScript/Node and this focused surface avoids pulling in a Grok-specific API or a new SDK merely to bridge a stable JSON-RPC protocol.

**Alternatives considered:** use a native Grok integration (rejected: it bypasses MCP and violates the requested boundary); add the MCP SDK (rejected for this small surface because a dependency-free server is easier to test and operate here).

### 2. Represent selectable devices as configured Gateway targets

`REACH_MCP_DEVICES` will optionally provide a JSON array of `{ id, gatewayUrl }` records. Without it, the connector exposes one `local-engine` device at `http://127.0.0.1:8787`. The device identifier selects the Gateway target; that Gateway remains responsible for the actual Engine it serves.

**Why:** the present Gateway is single-Engine and does not expose discovery, so a configuration-backed list makes `list_devices` truthful without widening the Gateway contract.

**Alternatives considered:** invent a Gateway device-list endpoint (rejected: it changes an unrelated service contract); accept arbitrary URLs in `pick_device` (rejected: that turns a trusted local connector configuration into an SSRF-like outbound proxy).

### 3. Keep Path 2 state inside one connector process

The server state begins as `unselected`. `pick_device` validates the configured ID, calls `/session/open`, polls `/session/status` until `ready` within a bounded timeout, then stores the selected device and lease expiry. It writes `notifications/tools/list_changed` only after that transition. `tools/list` builds from the state: the two picker tools initially, then those plus local-feel filesystem tools and `session.close`.

**Why:** it ensures the advertised filesystem surface cannot be called before its Engine session exists, and it keeps tool schemas device-free after selection.

**Alternatives considered:** advertise all tools from startup with hidden readiness errors (rejected: leaks an unscoped surface); use one tool name per device (rejected: dynamic configuration makes the tool set unwieldy).

### 4. Map calls directly to existing Gateway HTTP endpoints

For filesystem calls the connector creates a Gateway RPC envelope with a unique request ID and posts it to `/session/rpc`. Before each call it renews via `/session/renew` when the locally remembered expiry is near. For writes and edits it first posts `{ workspace, path, methods }` to `/grants`, then places the returned ID in `permission.grantId`. `session.close` posts `/session/close` and resets state only after that request succeeds or returns an already-closed outcome.

**Why:** Gateway remains the only issuer of mutation authority and the Engine receives unchanged Reach RPC.

**Alternatives considered:** perform filesystem work from the MCP process (rejected: it would use the wrong filesystem and evade Engine controls); cache or invent grants (rejected: grants are Gateway-issued, path/method-scoped, and expiring).

### 5. Prove notification-driven rediscovery with an in-process client

The package tests will connect a scripted JSON-RPC client to the stdio server, initialize it, inspect the initial list, make `pick_device` against a mock Gateway, wait for `notifications/tools/list_changed`, and issue a fresh `tools/list`. The test asserts the expanded names and the absence of `deviceId` in filesystem input schemas.

**Why:** it proves the precise host interaction that Path 2 relies on, instead of only unit-testing an internal state flag.

**Alternatives considered:** a manually run proof script only (rejected: it is easier to regress and cannot keep the package test command green).

### 6. Ship an opt-in static Path 1 compatibility mode

`REACH_MCP_TOOL_MODE=static` will advertise the filesystem tools and `session.close` from startup. Their schemas include a required `deviceId`; calls resolve that configured device, ensure its session is ready, and otherwise follow the same Gateway/grant flow as Path 2. The default remains dynamic Path 2.

**Why:** operators can use hosts that do not honor tool-list refresh without presenting the host filesystem as a substitute for Reach.

**Alternatives considered:** documentation-only fallback (rejected: it leaves non-refreshing hosts without a usable integration); enable static tools by default (rejected: it loses the cleaner selected-device schemas on hosts that support dynamic lists).

## Risks / Trade-offs

- [Some MCP hosts ignore `tools/list_changed`] → ship and document Path 1 static mode with explicit `deviceId` parameters.
- [Gateway may wait indefinitely for an Engine] → bound readiness polling and keep the connector unselected on failure.
- [Gateway lease timing can drift] → renew conservatively before each filesystem call and preserve Gateway error responses.
- [A process owns one selected device] → require a separate connector process for concurrently active devices; this keeps schemas simple and authorization clear.

## Migration Plan

1. Build and test the package independently, with the loopback Gateway as its default configuration.
2. Configure `REACH_MCP_DEVICES` where an operator needs named remote Gateway targets, then register the stdio command with an MCP-capable host.
3. Hosts that honor `tools/list_changed` use Path 2. Hosts that do not use the documented static Path 1 integration until they support refresh.

Rollback is removal of the MCP command from the host configuration. The connector stores no persistent session data; stopping it leaves normal Gateway session expiry/close behavior in force.
