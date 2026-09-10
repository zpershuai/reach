## Why

Grok Bot needs a standards-based MCP surface that feels local to the model while Reach continues to execute filesystem work only on the selected remote Engine. A dynamic tool list lets the connector keep device scope out of ordinary filesystem calls without exposing a device before the user has chosen one.

## What Changes

- Add a standalone Grok Bot MCP connector package that speaks MCP over stdio and uses the loopback Reach Gateway at `http://127.0.0.1:8787` by default.
- Add a device-selection phase that initially exposes only `pick_device` and `list_devices`.
- After a device is picked and its Gateway session is ready, send `notifications/tools/list_changed` and expose device-scoped `fs.read`, `fs.write`, `fs.edit`, `fs.list`, `fs.glob`, `fs.stat`, `fs.grep`, and `session.close` tools.
- Declare `capabilities.tools.listChanged: true` during MCP initialization and prove that a client re-fetches `tools/list` after the notification.
- Route session lifecycle, filesystem RPCs, lease renewal, mutation grants, and close requests through the existing Gateway; do not add native Grok `registerTool` integration.
- Document the static Path 1 fallback for hosts that ignore dynamic tool-list refresh notifications.

## Capabilities

### New Capabilities

- `grok-bot-mcp-connector`: An MCP server that selects a reachable Engine device and proxies local-feel filesystem and session tools through the Reach Gateway.

### Modified Capabilities

_None._

## Impact

- Adds a TypeScript package under `packages/` with an executable MCP stdio entrypoint, protocol handling, Gateway client, tests, and operator documentation.
- Uses the existing Gateway control-plane endpoints (`/session/open`, `/session/status`, `/session/renew`, `/session/rpc`, `/session/close`, and `/grants`) and existing Engine `fs.*` methods.
- Adds no native Grok SDK dependency or Engine-side `registerTool` API.
