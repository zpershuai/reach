# github-release-publish Specification

## Purpose

Defines how a SemVer tag for Gateway or Engine becomes a GitHub Release with platform artifacts, checksums, and a changelog, without publishing on ordinary commits.

## Requirements

### Requirement: Component tags publish GitHub Releases
Pushing `engine-vX.Y.Z` or `gateway-vX.Y.Z`, where `X.Y.Z` is SemVer, MUST start a GitHub Actions workflow that publishes a GitHub Release for that component. A tag whose version does not match the tagged component's source-of-truth manifest MUST fail the workflow and MUST NOT create or overwrite a Release.

#### Scenario: Engine tag matching the Cargo version publishes
- **WHEN** `engine-v0.2.2` is pushed and `crates/reach-rpc/Cargo.toml` package version is `0.2.2`
- **THEN** the workflow creates a GitHub Release for that tag and attaches Engine artifacts

#### Scenario: Tag version mismatch fails
- **WHEN** `gateway-v0.3.2` is pushed and `packages/reach-rpc/package.json` version is not `0.3.2`
- **THEN** the workflow fails and no GitHub Release is created for that tag

### Requirement: Ordinary commits do not publish
`push` and `pull_request` events that are not a matching component SemVer tag MUST NOT create GitHub Releases, upload Release assets, or retag published images.

#### Scenario: Main branch push stays a verify gate
- **WHEN** a commit is pushed to `main` without a component SemVer tag
- **THEN** existing verification still runs and no GitHub Release is published

### Requirement: Engine Release assets cover supported install targets
An Engine Release MUST include statically linked Linux x86_64 musl Engine binaries usable on systemd Linux and x86_64 musl OpenWrt, plus macOS arm64 and macOS x64 Engine binaries. Each binary MUST print the Release SemVer from `--version`. Missing a required platform artifact MUST fail the workflow.

#### Scenario: Engine Release lists Linux musl and macOS binaries
- **WHEN** an `engine-vX.Y.Z` Release is published
- **THEN** it includes Linux x86_64 musl, macOS arm64, and macOS x64 Engine binaries whose `--version` output equals `X.Y.Z`

### Requirement: Gateway Release assets include image and install tarball
A Gateway Release MUST include a Docker image for the existing amd64 Gateway container and a tarball that contains the prebuilt `packages/reach-rpc/dist` tree plus the Compose and Dockerfile files required to rebuild or recreate that container. The image and tarball Gateway `--version` output MUST equal the Release SemVer.

#### Scenario: Gateway Release serves compose rebuild inputs
- **WHEN** a `gateway-vX.Y.Z` Release is published
- **THEN** operators can obtain both a versioned Gateway image and a tarball whose Gateway `--version` output is `X.Y.Z`

### Requirement: Release notes summarize commits since the previous matching tag
Each published Release MUST include notes generated from commits since the previous GitHub tag of the same component prefix. The notes MUST NOT include private hostnames, SSH targets, credentials, or deployment inventory.

#### Scenario: Second Engine tag includes intervening commits
- **WHEN** `engine-v0.2.2` is published after `engine-v0.2.1`
- **THEN** the Release body lists changes from commits after `engine-v0.2.1` and contains no private deployment inventory

### Requirement: Release assets have checksums
Each published binary, tarball, or image digest MUST have a SHA-256 (or stronger) digest published with the Release so an updater can verify the download before replacing a running artifact.

#### Scenario: Engine binary digest is published
- **WHEN** an Engine Release includes `engine-linux-x64-musl`
- **THEN** the Release publishes a SHA-256 digest for that asset that matches the file bytes
