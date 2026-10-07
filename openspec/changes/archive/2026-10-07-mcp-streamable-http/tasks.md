## 1. Shared execution

- [x] 1.1 Extract the MCP core and preserve standalone stdio build artifacts.
- [x] 1.2 Add identity-bound internal Engine APIs using shared HTTP RPC validation.

## 2. Remote MCP

- [x] 2.1 Implement static remote tools, nonblocking readiness and independent Engine ownership.
- [x] 2.2 Add authenticated HTTP transport, version negotiation, bounded queues and lifecycle cleanup.

## 3. Distribution and verification

- [x] 3.1 Add the configurable Grok Bot plugin and deployment/verification docs.
- [x] 3.2 Add protocol, ownership, expiry, concurrency and real Engine filesystem tests; run repository checks and simplify the changes.

## 4. Review follow-up

- [x] 4.1 Pin sessions during body reads, reject dispatch after retirement, and schedule retirement cleanup immediately; cover DELETE/body and idle/body races.
- [x] 4.2 Correct unowned session_close results and preserve local validation messages; avoid positional tool-description overrides.
- [x] 4.3 Apply the 64 KiB limit at HTTP ingress rather than to expanded internal envelopes; cover a near-limit write and REST rejection.
- [x] 4.4 Verify concurrent initialization limits and handshake findings, document Origin setup checks, and run regression checks.
