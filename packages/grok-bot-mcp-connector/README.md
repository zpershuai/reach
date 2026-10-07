# Reach MCP connector

`@reach/grok-bot-mcp-connector` is a generic stdio MCP server that sends filesystem requests to a Reach Engine through its Gateway. Filesystem tools execute on the Engine; the connector reads its own optional private configuration file. See [installation instructions](../../docs/deploy/mcp.md) and the [deployment guide](../../docs/deploy/README.md).

Cloud clients can instead connect to the Gateway's authenticated Streamable HTTP `/mcp`. It exposes static underscore tools, registered devices and nonblocking connection/status calls. See the [Grok Bot plugin](../../grok-bot-plugin/README.md). The source core is shared under `reach-rpc/src/mcp`; the connector build copies compiled modules into its existing flat `dist`, so installed stdio paths and runtime dependencies stay compatible.

Every Engine installation automatically provisions a private Node.js runtime under `~/.reach/runtime/node` as an installation policy. The Rust Engine does not execute or require Node.js. The generated MCP configuration uses its stable `bin/node` path; Gateway and MCP processes on that host can share it without a system Node installation. This is also described in the MCP initialization instructions and the `list_devices` tool description. Standalone clients can install the same runtime with `python3 scripts/install-node-runtime.py`.

By default it exposes the `local-engine` device at `http://127.0.0.1:8787`:

```sh
npm --prefix packages/grok-bot-mcp-connector run build
node packages/grok-bot-mcp-connector/dist/main.js
```

Set `REACH_MCP_DEVICES` to a JSON array of named Gateway targets when using other devices:

```sh
REACH_MCP_DEVICES='[{"id":"workstation-a","gatewayUrl":"http://127.0.0.1:8787"}]' \
  node packages/grok-bot-mcp-connector/dist/main.js
```

## Dynamic Path 2 (default)

The connector declares `capabilities.tools.listChanged: true`. Initially `tools/list` contains `list_devices`, `get_versions`, and `pick_device`. A successful `pick_device` opens the selected Gateway session, waits until it is ready, then emits `notifications/tools/list_changed`. A host that re-fetches `tools/list` receives local-feel `fs.read`, `fs.write`, `fs.edit`, `fs.list`, `fs.glob`, `fs.stat`, `fs.grep`, and `session.close` tools already bound to that selected device.

The connector opens and checks readiness through `/session/open` and `/session/status`, renews with `/session/renew` as a lease nears expiry, sends filesystem calls to `/session/rpc`, and closes with `/session/close`. `fs.write` and `fs.edit` first obtain a path- and method-scoped Gateway grant from `/grants`.

## Static Path 1 fallback

Some MCP hosts ignore `notifications/tools/list_changed`. Set `REACH_MCP_TOOL_MODE=static` for those hosts:

```sh
REACH_MCP_TOOL_MODE=static node packages/grok-bot-mcp-connector/dist/main.js
```

Static mode advertises the filesystem and `session.close` tools from startup. Each requires a `deviceId` argument, then opens and binds that configured device for the call. It is less convenient than Path 2, but remains fully Gateway-mediated and works without tool-list refresh support.


## Session recovery and time budgets

The default readiness timeout is 150 seconds, covering the Engine's 120-second idle heartbeat interval plus connection setup. `REACH_MCP_READY_TIMEOUT_MS` and `REACH_MCP_READY_POLL_MS` override readiness polling. `REACH_MCP_REQUEST_TIMEOUT_MS` defaults to 35 seconds and bounds each HTTP request, including response-body reads. An unsuccessful readiness wait releases its own pending intent when the Gateway remains reachable.

The connector checks the selected session before each filesystem call. Idle sessions may naturally expire; a subsequent call opens a new session before sending RPC. Switching devices closes and drains the old session first. RPC, renew, and close carry the selected session id so stale state cannot act on a replacement session. A failed forwarded RPC is returned once without automatic replay. If cleanup also fails, the connector hides stale dynamic tools and retains the uncertain owner so a later selection drains it before opening another session. A request-scoped deadline error preserves a healthy selection. Stdio EOF closes the selected session after already-received requests finish.

An id returned by `/session/open` is bound immediately and later status must match it. Legacy Gateways that omit this id are supported by adopting the first id returned during acquisition, then enforcing that identity. Those Gateways lack intent ownership checks and require one controller; mixed-version operation cannot provide the newer Gateway's protection against concurrent controllers.

Known HTTP request rejections (invalid parameters, oversized payload, duplicate request id, or a full forwarding queue) return a tool error while keeping a healthy selection. A lost response, RPC timeout, or missing live session still triggers lifecycle cleanup. Neither path automatically retries the filesystem call.

For testing, install the shared compiler dependencies with `npm --prefix packages/reach-rpc ci --ignore-scripts`, then run `npm --prefix packages/grok-bot-mcp-connector test`. The build also builds the adjacent RPC package, which supplies the real Gateway integration fixture.
