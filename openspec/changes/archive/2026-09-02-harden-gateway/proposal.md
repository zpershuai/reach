## Why

The local gateway currently trusts caller-supplied write grants and leaves several session, parsing, filesystem, and resource-boundary gaps that make remote exposure unsafe. Harden these boundaries now so the gateway accepts only authorized, bounded work within explicitly configured workspaces.

## What Changes

- Add gateway-issued, scoped, expiring write grants and deny forged, expired, or mismatched grants.
- Make session credentials single-use with a 30-second TTL; permit only one live WebSocket and require a new session request before minting another credential.
- Require every request message to be a complete `reach-rpc/1.0` envelope bound to its WebSocket session.
- Bound HTTP/WebSocket/session/cursor/file operations and make grep/glob incremental, safe, and complete within their hard limits.
- **BREAKING** Require filesystem `workspace` names to resolve through a configured workspace-root map; reject unknown workspaces.
- Strengthen workspace writes against symlink traversal and time-of-check/time-of-use attacks using descriptor-relative operations.

## Capabilities

### New Capabilities

- `gateway-write-grants`: Gateway-managed, scoped, short-lived authorization grants for filesystem mutations.

### Modified Capabilities

- `gateway-heartbeat`: Single-use session token lifecycle and heartbeat issuance rules.
- `gateway-session-transport`: One live bounded transport, full request-envelope validation, and message limits.
- `reach-rpc-contract`: Full request envelope validation and workspace-name semantics.
- `workspace-filesystem-rpc`: Configured workspace roots, descriptor-safe writes, bounded incremental search, and file/cursor limits.

## Impact

Affected code includes the TypeScript gateway, workspace filesystem service, Zod DTO parsers, Rust Serde contract validation, integration/unit tests, and gateway documentation. The public local HTTP API gains `POST /grants`; filesystem users must configure and use a valid workspace name.
