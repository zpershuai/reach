## Context

See proposal.md for motivation. The gateway has in-memory heartbeat/session state and delegates RPC filesystem operations to a TypeScript workspace service. Existing parsers already define the cross-language envelope and filesystem DTOs, but gateway dispatch does not consistently use the full envelope parser. Workspace operations currently derive paths by resolution and collect search results before paging.

## Goals / Non-Goals

**Goals:**

- Make authorization and session state unforgeable, finite, and testable through public local endpoints.
- Keep filesystem traversal and mutation bounded even with hostile directory trees and inputs.
- Preserve the existing RPC method surface while enforcing the documented contract.

**Non-Goals:**

- Persist grants, credentials, or cursors across process restarts.
- Add remote authentication, multi-user authorization, or platform-independent descriptor safety emulation beyond the supported runtime.

## Decisions

### Keep grants and session credentials in gateway memory

Store random opaque IDs with issued scope and expiry. This fits the loopback gateway lifecycle and makes expiry and single-use semantics atomic in one process. A signed self-contained grant was considered, but it would complicate revocation and still require server-side session checks.

### Model session issuance as a small state machine

Track `sessionWanted`, one pending token and expiry, and one live socket. Heartbeats reuse an unexpired pending token; a successful upgrade consumes it and clears wanted state; close/timeout releases the live socket but does not re-enable issuance. This prevents a second socket and token minting without an explicit new request.

### Parse complete envelopes before dispatch

Use the existing Zod request-envelope parser at the WebSocket boundary and bind a generated session ID to that connection. Rust keeps its Serde parser aligned through contract tests. Hand-written field picking was considered but would drift from the published contract.

### Use bounded streaming walks and literal matching

Walk directory entries incrementally, filter glob matches during traversal, and stop only at relevant limits. Grep compares literal substrings, not user-derived regular expressions, tracks bytes scanned, and truncates emitted lines. This avoids regex denial of service and result collection that scales with the entire tree.

### Use descriptor-relative mutation paths

Open the real root directory once, then descend each component with `O_NOFOLLOW`; create missing parents one component at a time. Create the temporary file and rename it through the verified parent descriptor. Resolve-and-check paths was rejected because it cannot close the symlink replacement race between check and write.

### Configure workspace roots by name

Construct the workspace service with a name-to-root map, defaulting `default` to `~/.reach/workspace`. Tests supply `{ fixture: temporaryDirectory }`. This makes `workspace` meaningful and avoids accidental access to an implicit shared root.

## Risks / Trade-offs

- [Descriptor APIs vary by platform] → gate the hardened write implementation on available Node support and fail safely when the necessary no-follow operation is unavailable.
- [A full literal grep scan can still be expensive] → enforce the 8 MiB and 10,000-match caps while yielding to incremental iteration.
- [Strict envelope enforcement breaks legacy shortcut test messages] → update all clients and tests to send the published complete envelope.

## Migration Plan

1. Add parsers, limits, grant endpoint, and configurable-root support behind the existing local gateway API.
2. Update the engine client and integration tests to send complete envelopes and obtain grants through `POST /grants`.
3. Deploy with a named workspace configuration; callers using former arbitrary names must use `default` or an explicitly configured name.
4. Roll back by reverting the change; in-memory grants and pending tokens vanish on gateway restart.
