## Context

The current repository has a Rust Serde contract crate and a TypeScript Zod gateway, but no session RPC dispatcher for filesystem work. See proposal.md for motivation and the accompanying delta specs for the external contract.

## Goals / Non-Goals

**Goals:**

- Keep Rust and TypeScript filesystem DTO validation equivalent and camel-cased.
- Serve filesystem operations over the existing WebSocket session and its `tool.call` wrapper.
- Contain operations to a configured workspace root and bound traversal, search, and result sizes.
- Exercise a dedicated fixture tree without relying on a user's real home workspace.

**Non-Goals:**

- Implementing the Round 5 Grok Bot plugin.
- Supporting writes through symbolic links, arbitrary host paths, recursive directory mutation, or cursors that survive a session disconnect.
- Adding a persistent database or cross-session cursor store.

## Decisions

### Validate at the protocol boundary in both languages

Rust Serde types and TypeScript Zod schemas will define the method-specific parameter/result shapes, defaults, camelCase serialization, and `INVALID_PARAMS` failures. Both object validators retain their forward-compatible unknown-field behavior.

Alternatives considered: validate only in the TypeScript gateway or only in Rust. Either would leave a peer accepting messages the other rejects.

### Use a workspace service with an explicit root override

The service defaults to `~/.reach/workspace`; constructors accept a workspace root for tests. It canonicalizes existing paths where possible, verifies containment, treats lexically escaping paths as invalid, and rejects a symbolic-link final target for mutations.

Alternatives considered: resolve paths relative to the process working directory. That risks exposing unrelated repository or host files and makes fixture tests environment-dependent.

### Serialize mutations and publish files by replacement

A per-workspace async mutation lock protects revision check, content transformation, and replacement. Writes use a same-directory temporary file followed by rename so readers observe either the old or full new content. The service calculates SHA-256 from complete bytes before returning revisions.

Alternatives considered: direct writes. They can expose partial content and permit time-of-check/time-of-use conflicts between concurrent clients.

### Keep cursors in the WebSocket connection state

List, glob, and grep first generate a bounded ordered snapshot; a signed opaque cursor references its session-local snapshot and a continuation index. A cursor is checked against the method and normalized query before use, and connection close discards the state.

Alternatives considered: stateless cursors containing paths or global cursor state. The former leaks query data and complicates invalidation; the latter permits reuse after disconnect.

### Bound traversal and search before materializing results

Directory walks skip symlinks. Glob returns regular files, applies gitignore by default, and stops at the 10,000 hard result ceiling. Grep processes files incrementally, caps examined bytes at 8 MiB, caps matches at 10,000, and clips returned line text to 16 KiB.

Alternatives considered: shelling out to platform tools. Native traversal is portable and allows exact protocol limits and cursor behavior.

## Risks / Trade-offs

- [Filesystem races around external changes] → Re-check path type before mutation and use serialized, atomic replacement; revisions report detected stale writes.
- [Ignoring complex gitignore syntax] → Use an established library if needed, with fixture coverage for standard ignore files.
- [Large or binary inputs] → Enforce byte and output limits; treat file data as UTF-8 for text operations and return controlled errors for unsupported content.
- [Gateway compatibility] → Preserve the existing heartbeat/session lifecycle and add filesystem dispatch alongside the `job.done` handler.

## Migration Plan

1. Add shared DTOs and unit tests without changing existing Round 1–3 behavior.
2. Add the workspace service and WebSocket/tool dispatch, exercised with a fixture-root override.
3. Run Rust and TypeScript suites; rollback by removing the new method dispatch while the existing heartbeat and session messages continue unchanged.
