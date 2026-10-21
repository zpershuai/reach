# Spec Delta

## ADDED Requirements

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
