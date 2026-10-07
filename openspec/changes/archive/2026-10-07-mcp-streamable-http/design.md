## Context

The connector serializes stdio requests and uses one selected device. Gateway state is private to each Engine HTTP server. Remote HTTP must share business logic without loopback HTTP, child processes, or cross-device selection races.

## Goals / Non-Goals

**Goals:** Hosted MCP, bounded requests, registered-device discovery, identity-bound ownership, unchanged stdio distribution.

**Non-Goals:** SSE, forced takeover, OAuth, changing Engine heartbeat defaults, deploying to a real host.

## Decisions

- Extract the connector core into `reach-rpc/src/mcp`. Connector builds copy the compiled core into their existing flat distribution, preserving installation paths and independent version metadata.
- Expose an internal Engine API and use the same validation/grant/RPC implementation for HTTP and in-process callers.
- Route `/mcp` before Engine selection for both single and multi-Engine Gateways. Authenticate every method and validate supplied Origins against an explicit allowlist.
- Support MCP 2025-03-26 and 2025-06-18; negotiate unsupported client versions to 2025-06-18. Support March batches within established sessions, JSON-only replies, empty notification acknowledgments, GET 405, DELETE cleanup.
- Default to static underscore tools. Keep one shared MCP server per HTTP session with a map of identity-bound Engine clients; serialize its requests with a bounded queue.
- Open intent immediately, report connecting, and poll using `device_status`. Keep intent across polls; session expiry releases it. Never retry forwarded mutations.
- Keep 64 KiB bodies, default 25-second response budget, five-minute MCP idle TTL, and bounded session/queue counts. Closing must drain safely or retain cleanup ownership for retry.
- Count established-session body reads toward activity and queue admission. After each asynchronous boundary before dispatch, require the session to remain active. Retirement schedules one serialized drain immediately; queued work must never reopen a retired session after cleanup.
- Enforce HTTP size limits on received bytes. Internal envelope metadata is bounded by the existing WebSocket limit and must not reduce the advertised MCP request allowance.
- Closing an Engine owned by another session returns ENGINE_BUSY; closing an already unowned, inactive Engine remains idempotent. Only recognized Engine error codes receive explanatory suffixes.

## Risks / Trade-offs

- Grok Bot manifest URL interpolation is unverified → document a literal URL fallback and an actual-client verification step.
- Controller token grants broad workspace access → document scope and protect all methods; separate token remains future work.
- No SSE means no asynchronous notifications → advertise no list changes on the static HTTP surface.
- Live close is asynchronous → wait for bounded drain and retry failed cleanup without closing another owner's session.

## Migration Plan

Build, run local verification, rebuild the Gateway image, then configure the plugin URL and Controller token. No new ports or Caddy body-limit changes. Roll back the image to remove `/mcp`; stdio stays compatible.

## Open Questions

Actual Grok Bot secret-field metadata, minimum client version, and URL substitution must be checked with the host. No client version requirement is invented.
