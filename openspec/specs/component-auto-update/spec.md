# component-auto-update Specification

## Purpose

Defines how installed Gateway and Engine processes discover a newer GitHub Release, wait until they are idle, verify artifacts, and replace themselves through the existing supervisor without dropping a live session.

## Requirements

### Requirement: Auto-update is opt-in
Gateway and Engine MUST leave auto-update disabled unless the operator sets an explicit enable flag. Disabled processes MUST NOT poll GitHub, download artifacts, or replace binaries.

#### Scenario: Default install does not poll GitHub
- **WHEN** a Gateway or Engine starts without the auto-update enable flag
- **THEN** it never contacts GitHub Releases and keeps running its current artifact

### Requirement: Version checks use GitHub Releases
When auto-update is enabled, the process MUST poll GitHub Releases for its own component on a configured interval, compare the latest matching SemVer with the running version, and treat only a strictly newer SemVer as an available update.

#### Scenario: Newer Engine Release is detected
- **WHEN** a running Engine at `0.2.1` polls and GitHub has `engine-v0.2.2`
- **THEN** it records `0.2.2` as an available update and does not apply until idle

#### Scenario: Equal or older Release is ignored
- **WHEN** a running Gateway at `0.3.1` polls and the latest Gateway Release is `0.3.1` or older
- **THEN** it does not download or replace artifacts

### Requirement: Updates apply only while idle
Engine MUST NOT apply an update while in connecting, active, or draining session states. Gateway MUST NOT apply while any registered Engine has a wanted or live session. A detected update that cannot apply MUST remain pending and MUST be retried on the next idle check.

#### Scenario: Busy Engine defers apply
- **WHEN** an Engine has a ready session and a newer Release is available
- **THEN** it keeps the session, does not replace the binary, and retries after the session returns to idle heartbeat

#### Scenario: Idle Engine applies
- **WHEN** an Engine is heartbeating with no connecting, active, or draining session and a verified newer artifact is staged
- **THEN** it replaces the installed binary and exits so the supervisor starts the new process

#### Scenario: Gateway with any live Engine session defers
- **WHEN** auto-update is enabled on Gateway and at least one Engine has a wanted or live session
- **THEN** Gateway does not recreate its container or replace its image

### Requirement: Artifacts are verified before replace
Before replacing a running artifact, the updater MUST download the platform-matching Release asset, verify its published digest, and confirm `--version` (or image label equivalent) matches the Release SemVer. A failed download, digest mismatch, or version mismatch MUST leave the previous artifact running.

#### Scenario: Digest mismatch keeps the old Engine
- **WHEN** the downloaded Engine bytes do not match the published SHA-256
- **THEN** the installed binary is unchanged and the running process continues

### Requirement: Engine apply covers host and container supervisors
Engine apply MUST work for LaunchAgent, systemd, and OpenWrt procd host installs by replacing the installed binary and exiting 0 so the supervisor restarts it. When the Engine runs as a Docker container, apply MUST pull or load the matching image and recreate that container without changing Gateway credentials or workspace mounts.

#### Scenario: LaunchAgent Engine restarts on the new binary
- **WHEN** a macOS LaunchAgent Engine applies `0.2.2` while idle
- **THEN** `~/.local/share/reach/engine --version` reports `0.2.2` after the supervisor starts the replacement process

#### Scenario: Docker Engine container is recreated
- **WHEN** an Engine that runs as a Docker container applies a newer Engine image while idle
- **THEN** the replacement container reports the new Engine version and keeps using the existing Engine env and workspace mounts

### Requirement: Gateway apply does not run docker from the read-only container
Gateway apply MUST replace the host Compose image or rebuild from the Release tarball using a host-side helper that the Gateway process can invoke without writing the container root filesystem. The helper MUST preserve `gateway.env` and `engines.json`. Apply MUST NOT require the unprivileged Gateway process to talk to the Docker socket from inside the read-only container.

#### Scenario: Idle Gateway recreate preserves engine registry
- **WHEN** an idle Gateway applies `gateway-v0.3.2`
- **THEN** `/healthz` reports `gatewayVersion` `0.3.2` and the previous `engines.json` registrations still authenticate

### Requirement: Failed apply isolates from the session data plane
Update check and apply failures MUST be logged, MUST NOT crash the Gateway HTTP listener or Engine heartbeat loop, and MUST NOT originate `reach-rpc/1.0` data-plane requests. Network errors to GitHub MUST back off and retry on a later interval.

#### Scenario: GitHub is unreachable
- **WHEN** an enabled updater cannot reach GitHub Releases
- **THEN** the component continues serving or heartbeating at the current version and retries after backoff

### Requirement: Optional GitHub token is configuration not inventory
When the GitHub repository is private or the unauthenticated rate limit is insufficient, the updater MUST accept an optional token from local env or a file. Public documentation and Release notes MUST NOT include real tokens, hostnames, or device inventories.

#### Scenario: Private repository check uses configured token
- **WHEN** auto-update is enabled with a GitHub token in local env
- **THEN** version checks authenticate with that token and succeed against a private repository

### Requirement: Compose stages before idle admission
Compose helpers MUST prepare and verify the replacement before requesting idle admission. Retag/recreate MUST require component acknowledgement of a unique, expiring apply intent. Existing sessions MUST continue until idle; new admission MUST be deferred during apply and released on completion, failure or expiry.

#### Scenario: A session opens while the helper downloads
- **WHEN** a new session opens after an update request is written but before the helper finishes downloading and verifying the replacement
- **THEN** the helper waits for that session to close before receiving idle acknowledgement and recreating the container

#### Scenario: Prepared apply prevents a new session race
- **WHEN** a prepared helper requests idle admission and receives matching acknowledgement
- **THEN** no new REST/MCP session or Engine heartbeat lease is admitted until the helper completes, fails or its intent expires

#### Scenario: Helper timeout releases admission
- **WHEN** the helper cannot obtain idle acknowledgement or its apply intent expires
- **THEN** it does not recreate the running container, and session admission returns to normal

#### Scenario: No prepared helper leaves admission available
- **WHEN** a newer version is known but the helper has not prepared an apply intent
- **THEN** the component continues admitting sessions normally

### Requirement: Installation and update verify trusted release identity
Installers and updaters SHALL require an approved HTTPS release origin, component version, exactly one matching platform asset and a protected published checksum before executing or activating a download. Plain HTTP/file fixture sources MUST be available only through an explicit test mode. Cross-origin redirects MUST strip credentials, and redirects to unapproved or insecure origins MUST be rejected.

#### Scenario: A binary claims the right version on the wrong platform
- **WHEN** an asset has the expected version string but its executable format or architecture does not match the requested platform
- **THEN** validation fails before executing or replacing any installed component

#### Scenario: A checksum document contains duplicate entries
- **WHEN** the selected asset has duplicate, missing or malformed checksum entries
- **THEN** installation and update both fail closed

#### Scenario: A download redirects insecurely
- **WHEN** an HTTPS release request redirects to HTTP or an unapproved destination
- **THEN** the download is refused and no authorization header is forwarded there

#### Scenario: A local fixture is explicitly enabled
- **WHEN** an isolated installer test selects test mode and a local fixture source
- **THEN** fixture verification is permitted without weakening normal installation defaults

### Requirement: Failed installation preserves recoverable state
Failed downloads, source checks, platform checks, digest checks and version checks SHALL leave the prior installed version and credentials unchanged. Activation or startup failures MUST restore the supported supervisor's prior usable version and configuration, or report retained recovery artifacts and explicit recovery steps. Validation MUST complete before stopping the old service.

#### Scenario: Download fails midway
- **WHEN** a release download is truncated or fails
- **THEN** the partial artifact is never executed or installed and the old version remains usable

#### Scenario: Replacement fails to start
- **WHEN** an accepted replacement fails during activation or startup
- **THEN** rollback restores prior files and supervisor state, or reports a sanitized recovery failure without claiming a successful upgrade

### Requirement: Trust-channel limitations are explicit
Installation and update documentation SHALL identify the approved checksum channel and repository write protections as the current trust basis. It MUST explain that an attacker able to replace both an asset and its checksum can defeat digest-only verification. Signed releases and provenance MUST NOT be claimed until independently implemented and verified.

#### Scenario: A user inspects update guarantees
- **WHEN** the user reads the documented integrity model
- **THEN** it distinguishes corruption detection and protected-channel trust from cryptographic publisher signatures
