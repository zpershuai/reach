## 1. Gateway authorization

- [x] 1.1 Implement `POST /grants`, gateway-side scoped expiry validation for `fs.write`/`fs.edit`, and integration tests that obtain grants through the endpoint; verify forged, expired, and mismatched grants return `PERMISSION_DENIED`.

## 2. Session lifecycle and transport limits

- [x] 2.1 Implement one-time 30-second tokens, one-live-socket state, explicit re-request behavior, and tests covering concurrent upgrades and no token remint after close.
- [x] 2.2 Enforce 64 KiB HTTP bodies, 1 MiB WebSocket text messages, five-minute hard sessions, and 60-second idle sessions; verify each limit is rejected or closes cleanly.

## 3. RPC envelope contract

- [x] 3.1 Dispatch requests through the existing complete Zod envelope parser, bind session IDs to their connection, align Serde validation, and verify malformed/wrong-version/mismatched-session requests return `INVALID_PARAMS`.

## 4. Workspace roots and file limits

- [ ] 4.1 Add named workspace-root configuration with `default` mapping, unknown-workspace denial, 32-cursor cap, and 8 MiB read/write/edit limits; verify with isolated fixture-root tests.

## 5. Bounded filesystem search

- [ ] 5.1 Replace eager grep with incremental literal-substring walking capped at 8 MiB and 10,000 matches, skipping symlinks and truncating lines to 16 KiB; verify hostile patterns and limit behavior.
- [ ] 5.2 Apply glob matching during incremental traversal so the 10,000 cap counts matching files only, retain default gitignore behavior, and verify later matches after many nonmatches are found.

## 6. Descriptor-safe mutations

- [ ] 6.1 Implement verified descriptor-relative parent traversal, no-follow component checks, component-by-component mkdir, and same-directory temporary rename; verify symlink swap/traversal attempts cannot modify an external target.

## 7. Verification and delivery

- [ ] 7.1 Run TypeScript and Rust contract/integration tests plus strict OpenSpec validation; update documentation and mark completed hardening tasks only after all checks pass.
