# Reach Grok Bot MCP connector

`@reach/grok-bot-mcp-connector` is a stdio MCP server that sends filesystem requests to a Reach Engine through its Gateway. It never reads or writes the MCP host filesystem and does not use Grok's native `registerTool` API.

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

The connector declares `capabilities.tools.listChanged: true`. Initially `tools/list` contains only `list_devices` and `pick_device`. A successful `pick_device` opens the selected Gateway session, waits until it is ready, then emits `notifications/tools/list_changed`. A host that re-fetches `tools/list` receives local-feel `fs.read`, `fs.write`, `fs.edit`, `fs.list`, `fs.glob`, `fs.stat`, `fs.grep`, and `session.close` tools already bound to that selected device.

The connector opens and checks readiness through `/session/open` and `/session/status`, renews with `/session/renew` as a lease nears expiry, sends filesystem calls to `/session/rpc`, and closes with `/session/close`. `fs.write` and `fs.edit` first obtain a path- and method-scoped Gateway grant from `/grants`.

## Static Path 1 fallback

Some MCP hosts ignore `notifications/tools/list_changed`. Set `REACH_MCP_TOOL_MODE=static` for those hosts:

```sh
REACH_MCP_TOOL_MODE=static node packages/grok-bot-mcp-connector/dist/main.js
```

Static mode advertises the filesystem and `session.close` tools from startup. Each requires a `deviceId` argument, then opens and binds that configured device for the call. It is less convenient than Path 2, but remains fully Gateway-mediated and works without tool-list refresh support.
