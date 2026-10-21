# Spec Delta

## Purpose

Defines a reviewable source-publication candidate and its evidence so maintainers can publish approved source and distribution artifacts without exposing private deployment material or silently losing scan coverage.

## ADDED Requirements

### Requirement: Clean source snapshot export
Publication tooling SHALL export an explicitly selected committed revision into a separate candidate directory without inheriting private Git history, ignored configuration or generated local state. It MUST preserve licenses, copyright and required attribution. Export MUST NOT modify the source checkout, rewrite history, contact a public remote or change repository visibility.

#### Scenario: An approved revision is exported
- **WHEN** the maintainer exports a selected commit into an empty candidate directory
- **THEN** only approved source files and attribution are included, no `.git` or `.reach/` is copied, and the original checkout and references are unchanged

#### Scenario: The target already contains files
- **WHEN** an export targets a nonempty directory
- **THEN** it fails before overwriting any file

### Requirement: Complete publication-surface inventory
A readiness inventory SHALL identify the candidate tree and every branch, tag, attachment, release asset, image digest, historical image layer and build context planned to remain public. Each item MUST have a stable identifier and review status. Timeouts, missing downloads, unknown scope and omitted image layers MUST be recorded as incomplete coverage and block approval.

#### Scenario: An asset cannot be downloaded
- **WHEN** any planned public asset times out or cannot be scanned
- **THEN** that item remains incomplete and the candidate cannot pass the publication gate

#### Scenario: An image has content removed in a later layer
- **WHEN** the final filesystem is clean but an earlier image layer contains deployment data
- **THEN** historical-layer review reports the finding and blocks approval of that image

### Requirement: Automated scans and human deployment review
Every inventoried item SHALL undergo pinned secret scanning and human review for deployment identifiers, topology, logs, accounts and backup details. Public examples MUST use reserved domains, documentation addresses and generic configurable values. Findings MUST carry disposition; any confirmed live credential exposure MUST require revocation or rotation evidence before approval, even if removed from the candidate.

#### Scenario: A secret is removed without being revoked
- **WHEN** a confirmed exposed valid credential is deleted from source but no revocation or rotation is recorded
- **THEN** the publication gate remains blocked

#### Scenario: A synthetic scanner regression is introduced
- **WHEN** a test fixture includes a synthetic prohibited secret or deployment marker
- **THEN** the scanner rejects the fixture while accepting documented reserved examples

### Requirement: Private reproducible review evidence
Scan reports, real inventories, exception lists, private-to-public revision mappings and verification results SHALL be written only under ignored `.reach/` or outside the repository, with restrictive access. Evidence MUST include candidate digests, scope, tool versions, date, results and reviewed exceptions. Public outputs MUST contain only sanitized procedures and approved source provenance.

#### Scenario: A report contains a private deployment match
- **WHEN** a scan identifies a real deployment value
- **THEN** the value and detailed report remain in private evidence and are absent from tracked documentation and shared CI logs

### Requirement: Evidence-bound publication approval
Publication approval SHALL require complete scan coverage, resolved findings or explicitly reviewed non-secret exceptions, P0 security acceptance and release validation for the exact candidate bytes. Modifying candidate content MUST invalidate prior approval. Publishing and anonymous-access verification MUST be distinct recorded steps; a prepared snapshot MUST NOT be reported as already public.

#### Scenario: Candidate bytes change after review
- **WHEN** a previously approved source tree or asset digest changes
- **THEN** prior approval no longer passes for that item and review must be repeated

#### Scenario: Implementation finishes without publication
- **WHEN** tooling and local checks pass but no public repository has been created
- **THEN** status reports preparation complete and public/anonymous verification pending
