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
