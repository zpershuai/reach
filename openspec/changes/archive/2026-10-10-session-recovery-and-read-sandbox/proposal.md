## Why

The Grok MCP connector treats a Gateway session as a one-shot local binding: its 15s ready wait loses to the Engine's 120s idle heartbeat, a dead session is never reopened, and a connecting WebSocket can occupy the only session slot for five minutes. Independently, `fs.read` still uses path-string I/O, so non-UTF-8 files look missing, a FIFO blocks the Engine thread, and symlink checks are TOCTOU. Round 5 just shipped the connector; these are the first cases a default loopback Grok path hits.

## What Changes

- Lengthen MCP ready wait to outlast one idle Engine heartbeat plus connection setup (default 150s) and keep polling while Gateway status is `wanted`, `pending`, or `connecting`.
- On ready-wait failure, best-effort `POST /session/close` so an abandoned wanted/connecting session does not brick later opens.
- Confirm Gateway `ready` before no-oping a same-id `pick_device`; otherwise close and reopen.
- After a selected session dies, reads reopen and retry once. Mutations retry only when dispatch has not started or the Gateway explicitly reports no live/ready session; uncertain dispatched mutations return `RESULT_UNKNOWN` without replay.
- Close a live WebSocket that never sends valid `session.ready` within a connecting bound (default 15s) so `/session/open` is not 409 for the idle/lease window.
- Open `fs.read` and `fs.stat` with the same no-follow, non-blocking descriptor-relative I/O as mutations. Invalid UTF-8 on a regular file returns `NOT_UTF8`, not `FILE_NOT_FOUND`. FIFO/device/symlink must not block and must not follow.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `grok-bot-mcp-connector`: Ready wait, close-on-timeout, same-id health check, and one-shot reopen after a dead Gateway session.
- `gateway-session-transport`: Connecting-slot timeout for a live WebSocket that has not become ready.
- `workspace-filesystem-rpc`: Descriptor-relative `fs.read`/`fs.stat`, `NOT_UTF8`, and non-blocking denial of FIFO/device/symlink on the read path.

## Impact

- TypeScript: `packages/grok-bot-mcp-connector` (config default, Gateway client, `selectDevice`/`callFilesystem`) and `packages/reach-rpc` Gateway connecting timer.
- Rust: `crates/reach-rpc/src/workspace.rs` `read`/`stat` reuse `open_verified_parent`.
- Docs: MCP README ready-timeout default.
- No Engine heartbeat early-wake, no grant-to-session binding, no gitignore rewrite, no list/glob/grep descriptor I/O.
