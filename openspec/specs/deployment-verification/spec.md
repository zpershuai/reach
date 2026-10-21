# Deployment verification

## Purpose
Keep specification validation, installation recovery and deployment packaging reproducible and covered by suitable CI runners.

## Requirements

### Requirement: Linux installation restores failed upgrades
The Linux installer MUST verify artifacts and runtime and stage the complete release before stopping the old service. Activation MUST atomically replace each file where possible. On failure it MUST restore files, runtime pointer, enabled state and active state. If rollback fails it MUST report retained recovery backups. Fault-injection tests MUST cover installation steps, start failure, rollback and successful upgrade.

#### Scenario: Activation or service start fails
- **WHEN** a Linux installation fails after stopping the old service
- **THEN** its prior files and service state are restored, or explicit rollback errors and retained recovery backups are reported

### Requirement: CI gates specs and source verification
CI MUST run pinned OpenSpec 1.14.1 strict validation, installer recovery tests and scripts/verify.sh on Linux and macOS. Specification structure errors MUST fail the gate. Shared expected fixtures and regression tests MUST verify behavior that structural OpenSpec validation cannot prove.

#### Scenario: A specification or regression fails
- **WHEN** strict specification validation or a regression test fails
- **THEN** the verification job fails

### Requirement: Deployment artifacts have executable packaging checks
Linux x86_64 CI MUST build and smoke-test the Gateway container and static musl Engine. It MUST build the OpenWrt Node bundle twice, compare the artifacts, verify manifest hashes, and execute private Node and its process.execPath child without host musl/C++ dependencies. Base images and patch tools MUST be pinned. Documentation MUST distinguish simulated installer tests and bundle smoke from actual systemd/procd and device recovery.

#### Scenario: Bundle omits a required private library
- **WHEN** bundled Node or its child cannot execute in the isolated runtime environment
- **THEN** packaging verification fails

### Requirement: CI builds named release assets without publishing
Linux and macOS CI MUST be able to produce the Engine and Gateway artifacts named by `github-release-publish` as part of packaging or a dry-run release job. A non-tag `push` or `pull_request` MUST still run the existing verify and packaging checks and MUST NOT create a GitHub Release.

#### Scenario: Packaging job produces Engine and Gateway artifacts
- **WHEN** Linux x86_64 CI runs packaging verification
- **THEN** it builds the static musl Engine and Gateway container used as Release assets, and it does not publish a GitHub Release

#### Scenario: macOS CI produces a native Engine binary
- **WHEN** macOS CI runs verification for this change
- **THEN** it builds a native Engine binary whose `--version` matches the Cargo package version

### Requirement: Security regression matrix blocks release
Linux and macOS verification SHALL test missing/expired/revoked credentials, cross-principal/Engine/workspace access, read-only mutation denial, grant scope, path escape, symlinks, argument injection, invalid TLS certificates and diagnostic confidentiality. Tests MUST assert no forbidden side effects or forwarding. Release packaging MUST verify platform, digest, version and license failures.

#### Scenario: Authorization is deliberately bypassed
- **WHEN** an isolated test disables policy enforcement on one forwarding path
- **THEN** a negative regression fails because unauthorized forwarding or a side effect is detected

#### Scenario: A certificate is invalid
- **WHEN** Engine heartbeat, Engine WSS or Connector HTTPS uses an expired, untrusted or wrong-host certificate
- **THEN** the connection fails without exposing credentials or falling back to insecure transport

#### Scenario: Package integrity is deliberately bypassed
- **WHEN** an isolated fault-injection test disables the package digest check
- **THEN** a corrupted-package regression fails instead of installing the package successfully

### Requirement: Failure recovery preserves command identity
Integration verification SHALL cover connection failure, token expiry, incompatible protocol, reconnect, timeout and cancellation with a real Engine. Reconnect MUST NOT automatically replay mutating work. Process cancellation MUST terminate managed ordinary descendants within the documented bound. Lost write replies MUST remain explicitly uncertain rather than implying rollback or durable exactly-once execution.

#### Scenario: A process reply is lost during disconnect
- **WHEN** a launch response is lost and the connection is re-established
- **THEN** no process is automatically launched again, and recovery follows the documented session and launch identity rules

#### Scenario: A running process is cancelled
- **WHEN** a client cancels or loses its authorized session while a task has ordinary child processes
- **THEN** managed process groups are cleaned up and no unrelated process is signaled

### Requirement: Verification tools and dependencies are reproducible
CI SHALL use committed dependency locks, an exact Rust toolchain, exact Node/Python verification versions, pinned scanner versions and immutable action revisions. Builds MUST reject lock drift and record toolchain identifiers. Tool updates MUST be explicit reviewable changes; supported runtime ranges MUST be documented separately from exact CI pins.

#### Scenario: A runner provides a different compiler
- **WHEN** the runner's default toolchain differs from the committed verification toolchain
- **THEN** CI installs the committed version or fails clearly rather than silently changing build inputs

### Requirement: First-use acceptance starts from a clean environment
Maintainers SHALL validate documented source build or installation, Gateway startup, Engine enrollment, scoped MCP connection, test-workspace access, an explicitly enabled script, device revocation and uninstall without historical configuration. Examples MUST use reserved values and local generated credentials. Reports MUST record actual durations, blockers and environment privately; no fixed setup duration may be promised without measured evidence.

#### Scenario: An unfamiliar user follows the guide
- **WHEN** the user starts in an isolated environment with only documented prerequisites
- **THEN** the end-to-end sequence succeeds using the documented steps and uninstall preserves user workspaces unless explicitly selected for deletion

#### Scenario: Execution acceptance uses a restricted identity
- **WHEN** the documented execution example is validated
- **THEN** it runs under a restricted non-root OS identity or genuine isolation, explains remaining script privileges, and does not treat cwd as a security sandbox

### Requirement: Compatibility and contribution routes are verifiable
Public documentation SHALL specify supported platforms and prerequisites, Engine/Gateway/runtime/Connector compatibility, upgrade order, failure recovery and support policy. Issue/PR templates MUST request versions and sanitized reproductions. The private vulnerability reporting route MUST be verified on the publication target before claiming it is available. Fork contributors MUST be able to build and test without deployment credentials.

#### Scenario: Optional security reporting is unavailable
- **WHEN** the target repository does not enable the documented private advisory channel
- **THEN** public-readiness acceptance stays incomplete until that route or an actually verified private alternative is available

#### Scenario: Components are incompatible
- **WHEN** a documented unsupported component/protocol combination is exercised
- **THEN** it fails with an actionable sanitized diagnostic without claiming compatibility or replaying operations
