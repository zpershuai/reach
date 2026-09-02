## 1. Gateway session lifecycle

- [x] 1.1 Extend the heartbeat response and local gateway with one-time session credentials plus authenticated WebSocket upgrade, and verify gateway tests retain 120/5 heartbeat behavior and cover credential rejection.
- [x] 1.2 Close an accepted WebSocket after a `job.done` signal, emit connect/close log events, and verify the gateway test observes both events and an idle heartbeat afterward.

## 2. Rust engine and integration proof

- [x] 2.1 Add a Rust `session-client` binary that posts device information, consumes the returned session credentials, sends `job.done`, and verify it builds and runs against the local gateway.
- [ ] 2.2 Add an automated cross-language session test and local run instructions that prove one engine connection followed by gateway closure; verify with `npm test` and `cargo test`.
