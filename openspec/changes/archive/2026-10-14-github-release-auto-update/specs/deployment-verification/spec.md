# Spec Delta

## ADDED Requirements

### Requirement: CI builds named release assets without publishing
Linux and macOS CI MUST be able to produce the Engine and Gateway artifacts named by `github-release-publish` as part of packaging or a dry-run release job. A non-tag `push` or `pull_request` MUST still run the existing verify and packaging checks and MUST NOT create a GitHub Release.

#### Scenario: Packaging job produces Engine and Gateway artifacts
- **WHEN** Linux x86_64 CI runs packaging verification
- **THEN** it builds the static musl Engine and Gateway container used as Release assets, and it does not publish a GitHub Release

#### Scenario: macOS CI produces a native Engine binary
- **WHEN** macOS CI runs verification for this change
- **THEN** it builds a native Engine binary whose `--version` matches the Cargo package version
