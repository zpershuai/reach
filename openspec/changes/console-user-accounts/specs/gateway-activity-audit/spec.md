# Spec Delta

## MODIFIED Requirements

### Requirement: Ingress client attribution
Each event SHALL carry an ingress client label and type:
- `mcp-http`: from the HTTP MCP `initialize` `clientInfo` name and version.
- `controller`: from an optional `X-Reach-Client` header, at most 64 printable characters, defaulting to `Controller API`.
- `engine`: for heartbeats.
- `console`: for console account actions, labelled with the acting username; actions without a signed-in account, such as setup or the offline password reset, use `Setup` or `Host CLI`.

Self-reported labels MUST be marked as unverified. Console labels come from the authenticated session and MUST be marked as verified.

#### Scenario: Remote MCP client
- **WHEN** an HTTP MCP session initialized with `clientInfo` `{name:"grok-bot", version:"1.2"}` calls `fs_read`
- **THEN** its events carry client type `mcp-http`, label `grok-bot 1.2` and `verified:false`

#### Scenario: Oversized client header
- **WHEN** a controller sends an `X-Reach-Client` header longer than 64 characters or containing control characters
- **THEN** the label falls back to `Controller API` and the request is otherwise processed normally

#### Scenario: Admin removes a device
- **WHEN** signed-in admin `alice` removes Engine `nas-01`
- **THEN** the `admin.action` event carries client type `console`, label `alice` and `verified:true`
