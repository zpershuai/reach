# Spec Delta

## ADDED Requirements

### Requirement: HTTP MCP sessions are attributed
Each HTTP MCP session SHALL keep the `clientInfo` name and version from its `initialize` request as its ingress label. Every RPC, denial and Engine-session action it causes MUST be attributed to that label. Session creation and retirement MUST be published as `client.connected` and `client.disconnected` events when the console is enabled.

#### Scenario: Attributed tool call
- **WHEN** an HTTP MCP session initialized as `chatgpt 1.0` calls `fs_list`
- **THEN** the resulting audit record names client type `mcp-http` and label `chatgpt 1.0`

#### Scenario: Idle retirement
- **WHEN** an HTTP MCP session expires after inactivity
- **THEN** a `client.disconnected` event with reason `idle` is published

### Requirement: Console-initiated session retirement
The Gateway SHALL let the console retire every HTTP MCP session with a given ingress label. Retirement MUST follow the same path as a client DELETE. Later requests using a retired session id MUST receive 404, and the retirement MUST be recorded as an `admin.action`.

#### Scenario: Owner disconnects a bot
- **WHEN** the owner disconnects label `grok-bot 1.2` while it owns a ready Engine session
- **THEN** that Engine session drains and closes, and the bot's next request with its old `Mcp-Session-Id` receives 404
