## Why

Reach needs one unambiguous, portable request contract before gateway and engine work can interoperate. Establishing the Round 1 DTOs and a shared fixture now makes Rust and TypeScript implementations agree at the wire boundary.

## What Changes

- Introduce the `reach-rpc` protocol envelope at version `1.0`.
- Define the `fs.read` request parameters and result payload, including line defaults and opaque content revision semantics.
- Provide Rust Serde and TypeScript Zod DTO packages that ignore unknown wire fields and reject invalid required values as `INVALID_PARAMS`.
- Add a fixture-based cross-language round-trip check for an `fs.read` request.

## Capabilities

### New Capabilities

- `reach-rpc-contract`: Defines the Reach Round 1 wire envelope and `fs.read` message contract.

### Modified Capabilities

- None.

## Impact

- Adds a Rust crate and TypeScript package for the shared protocol contract.
- Adds a JSON fixture and local validation script/test.
- Does not add network transport, heartbeat behavior, or capabilities from later rounds.
