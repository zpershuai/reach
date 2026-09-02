## 1. Contract packages

- [x] 1.1 Create the Rust `reach-rpc` crate with Serde DTOs for the request envelope, `fs.read` parameters, and result; verify `cargo test -p reach-rpc` passes.
- [x] 1.2 Create the TypeScript contract package with matching Zod schemas and canonical JSON serialization; verify its test command passes.

## 2. Cross-language fixture

- [ ] 2.1 Add a canonical `fs.read` request fixture that exercises defaults and unknown-field ignoring; verify both package tests parse it and serialize the normalized payload.
- [ ] 2.2 Add and run a fixture validation command that compares Rust and TypeScript normalized payloads; verify it exits successfully.
