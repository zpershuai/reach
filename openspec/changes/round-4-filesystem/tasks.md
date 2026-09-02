## 1. Cross-language filesystem contracts

- [x] 1.1 Add Rust Serde and TypeScript Zod DTOs, defaults, camelCase serialization, unknown-field tolerance, and `INVALID_PARAMS` validation for all Round 4 filesystem methods; verify Rust unit tests and the TypeScript contract tests pass.

## 2. Workspace filesystem service

- [x] 2.1 Implement contained workspace path resolution, SHA-256 revisions, bounded read/list/stat, and atomic serialized write/edit operations with the specified error codes; verify fixture-tree tests cover reads, pagination, stale `ifMatch`, and edit match failures.
- [x] 2.2 Implement files-only gitignore-aware globbing and bounded grep with session-query cursor validation, symlink skipping, and all specified resource limits; verify fixture-tree tests cover limits, continuation cursors, and invalid cursor reuse.

## 3. Session integration and regression coverage

- [x] 3.1 Dispatch filesystem methods both directly and through `tool.call` on the existing WebSocket session while preserving heartbeat and job completion behavior; verify the gateway integration tests pass.
- [x] 3.2 Run the complete Rust and TypeScript test suites against the documented fixture workspace and verify Round 1–3 regression coverage remains green.
