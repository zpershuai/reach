## Why

Reach sessions currently establish a transport and validate the initial `fs.read` DTO, but they do not provide a usable workspace filesystem service. Clients need a bounded, concurrency-safe way to inspect and change the session workspace.

## What Changes

- Add filesystem RPC operations for reading, listing, statting, writing, editing, globbing, and grepping files rooted at the configured Reach workspace.
- Define revision-based optimistic concurrency, atomic serialized writes, pagination cursor handling, path and symlink safety, and resource limits.
- Expose the operations directly and through the existing `tool.call` dispatch path, with matching Rust Serde and TypeScript Zod contract validation.
- Add fixture-tree tests that exercise all Round 4 filesystem behavior while retaining the Round 1–3 contract and gateway behavior.

## Capabilities

### New Capabilities

- `workspace-filesystem-rpc`: Bounded, safe workspace filesystem operations over the Reach RPC session.

### Modified Capabilities

- `reach-rpc-contract`: Extend the portable Reach RPC contract with the Round 4 filesystem method parameters and results.

## Impact

- Rust `reach-rpc` DTOs, session dispatch, and tests.
- TypeScript Zod DTOs, gateway dispatch, and tests.
- The default workspace root at `~/.reach/workspace` (with a documented test override).
