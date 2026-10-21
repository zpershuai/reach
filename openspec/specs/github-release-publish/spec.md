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

### Requirement: License compliance is a release gate
Every published Engine/Gateway binary distribution, archive and image SHALL provide the Apache-2.0 license and applicable third-party notices in its documented distribution layout. A standalone binary MUST have a required companion license/notice asset covered by the release manifest; bundled distributions MUST contain the required files. Missing required notices MUST fail candidate validation before publication.

#### Scenario: A platform omits its notices
- **WHEN** any required platform distribution lacks its required license or third-party declaration
- **THEN** packaging or candidate validation fails even if other platforms pass

#### Scenario: Existing fixes are already present
- **WHEN** a candidate already contains the previously completed license and notice fixes
- **THEN** those files are validated and preserved without treating the historical release issue as a new unfixed defect

### Requirement: Release provenance identifies public source
A release manifest SHALL identify component version, approved public source revision, toolchain identifiers, expected asset names, platform identities and SHA-256 digests. Notes MUST point to anonymously accessible matching source once published. Private revision mappings and deployment details MUST NOT appear in public release metadata. Missing, duplicate or unexpected publishable assets MUST fail validation.

#### Scenario: A candidate contains an extra attachment
- **WHEN** an asset selected for publication is not in the approved manifest
- **THEN** publication validation fails until it is removed or explicitly inventoried and reviewed

#### Scenario: Public distribution uses a separate repository
- **WHEN** component binaries are published in a repository separate from source
- **THEN** metadata still identifies the matching public source revision and each asset's version and digest

### Requirement: Publishing authority is isolated from untrusted builds
PR and ordinary commit verification SHALL run without release credentials or publication side effects. Publication MUST require an approved component tag, successful candidate gates and least-privilege credentials limited to configured targets. Build jobs MUST NOT receive cross-repository publication credentials. Release checksums MUST be served through authenticated HTTPS from the approved release origin with protected write access.

#### Scenario: A fork changes release scripts
- **WHEN** a pull request from a fork modifies a publishing script or workflow
- **THEN** verification runs without publication secrets and cannot publish assets or images

#### Scenario: A candidate fails security or packaging gates
- **WHEN** any required gate fails or is incomplete
- **THEN** the publication job does not receive authorization to publish that candidate

### Requirement: Published bytes are verified independently
Release verification SHALL download every expected public asset from its configured distribution endpoint and compare its bytes, digest, version, platform and required notices with the approved build manifest. Image verification MUST compare the published digest. Failures or missing items MUST produce incomplete release acceptance without deleting or silently overwriting published releases.

#### Scenario: A download differs from the build artifact
- **WHEN** a remote asset's digest differs from the approved candidate
- **THEN** release acceptance fails and reports a sanitized discrepancy for maintainer handling

#### Scenario: The last asset times out
- **WHEN** all but one expected asset verifies and that remaining download times out
- **THEN** acceptance remains incomplete rather than reporting the whole release verified
