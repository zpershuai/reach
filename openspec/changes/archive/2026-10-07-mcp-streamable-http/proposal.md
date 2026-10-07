## Why

Cloud MCP hosts cannot launch Reach's stdio connector. Issue #1 requires a hosted endpoint so Grok Bot can use registered Engine workspaces through the existing Gateway.

## What Changes

- Add authenticated, stateful Streamable HTTP at `/mcp`, without another listener.
- Share connector tools and filesystem dispatch in process while retaining standalone stdio artifacts.
- Expose static underscore tool names, registered devices, nonblocking readiness and ownership-safe cleanup.
- Ship a configurable Grok Bot plugin and reusable deployment/verification instructions.

## Capabilities

### New Capabilities
- `mcp-streamable-http`: HTTP transport, session limits, security and lifecycle.

### Modified Capabilities
- `grok-bot-mcp-connector`: shared dispatch, remote static tool surface and nonblocking device readiness in addition to stdio.

## Impact

TypeScript Gateway and connector, build output, verification scripts, deployment docs, and a new plugin directory. Existing Engine protocol and running installations remain unchanged. No new runtime dependencies or ports.
