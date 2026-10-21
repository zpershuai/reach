# Spec Delta

## ADDED Requirements

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
