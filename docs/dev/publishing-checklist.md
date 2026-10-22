# Publishing checklist

Review a clean source snapshot and the retained publication surface before publishing a component release. The official public source and release repository is `zpershuai/reach`; a new source repository is not required for each release. Preserve existing installations and any private backups. This procedure does not publish, push tags, rewrite history, rotate credentials or restart services.

Read [AGENTS.md](../../AGENTS.md). Real inventories, findings, exceptions, private revision mappings and verification reports belong only in ignored `.reach/` or outside the repository. Do not paste raw findings into public issues or CI logs. Tracked examples use reserved domains and addresses.

## 1. Install the pinned scanner

```bash
python3 scripts/install-publication-tools.py
```

The installer verifies the platform package against `scripts/publication-tools.json` before installing Gitleaks 8.30.1 under `.reach/tools/`. For a previously downloaded upstream package, use `--archive /path/to/package.tar.gz`; its checksum is still verified. Tool updates require a reviewed pin change. HTTPS plus checksums does not imply publisher signatures.

## 2. Export a selected committed revision

Review source and attribution before selecting a commit. Uncommitted changes are not exported. An optional `--include-list` points to a private JSON array of approved repository-relative files; required attribution cannot be omitted.

```bash
source_revision="$(git rev-parse HEAD)"
python3 scripts/prepare-public-source.py \
  --revision "$source_revision" \
  --output .reach/public-candidate \
  --record .reach/publication/source-export.json
```

The output must be empty or absent. Export rejects included symlinks/submodules and excludes `.git/`, `.reach/`, private deployment configuration, logs, dependency trees and generated outputs. LICENSE and attribution remain. Exclusion alone does not prove the remaining source is safe.

Review all retained files, including archived planning material, scripts, documentation, examples and build inputs. If material is unsuitable, fix and commit the reusable source changes, select the new revision and export to a new empty directory. Do not modify a running installation for documentation cleanup.

## 3. Enumerate the entire publication surface

Create `.reach/publication/inventory.json`. Every category is required and every scoped ID needs exactly one item:

| Category | Required scope |
| --- | --- |
| `candidate` | Approved source tree |
| `git-ref` | Every branch/tag whose history will be public |
| `release-asset` | Every attachment or distribution that will remain public |
| `image` | Every continuing public image and all its historical layers |
| `build-context` | Every public build context |

Enumerate remote assets/references first; completeness cannot be inferred from successful downloads. Record unknowns and failures. Empty categories require reviewed reasons. A new snapshot does not inherit private branches/tags.

Example structure (replace values only in the private inventory):

```json
{
  "schemaVersion": 1,
  "scope": {
    "candidate": ["source"],
    "git-ref": [],
    "release-asset": [],
    "image": [],
    "build-context": []
  },
  "items": [
    {
      "id": "source",
      "kind": "candidate",
      "path": "../public-candidate",
      "sha256": "REPLACE_WITH_CANDIDATE_DIGEST"
    }
  ]
}
```

Paths are relative to the inventory directory. Git items use `path` for a local repository and `revision` for a reference; fingerprints include all reachable objects and annotated tag messages. Assets use a local `path` or approved HTTPS `url`. Set `format: "archive"` for archives; recognizable archives are expanded even if mislabeled as files. Images use Docker-save or OCI archives. Each referenced layer is scanned separately, so later deletion cannot hide earlier contents. Missing layers or unsupported archives remain incomplete.

Calculate local fingerprints and plan bindings without approving anything:

```bash
python3 scripts/verify-publication.py --fingerprint .reach/public-candidate
python3 scripts/verify-publication.py --fingerprint /path/to/image.tar
python3 scripts/verify-publication.py --fingerprint /path/to/candidate-repo --revision candidate-tag
python3 scripts/verify-publication.py .reach/publication/inventory.json --plan-sha256
```

File, tree and Git-reference fingerprints have different meanings. Include sidecar licenses, manifest files and every continuing distribution; one timeout still blocks acceptance.

## 4. Scan and review the exact bytes

```bash
python3 scripts/verify-publication.py .reach/publication/inventory.json \
  --report .reach/publication/report.json
```

Exit 1 means not ready, including the expected first run without human review/P0 evidence. stdout contains a sanitized summary. Reports use mode 0600; in-repository destinations must be ignored under `.reach/`. Scanner version/configuration digest are recorded. Inline `gitleaks:allow` comments and ambient ignore files cannot suppress findings.

Also review hostnames, accounts, topology, logs and backup details manually. Secret-pattern detection does not identify every deployment detail. Add an item's `review` after reviewing its exact bytes:

```json
{
  "status": "approved",
  "sha256": "EXACT_ITEM_DIGEST",
  "reviewer": "PRIVATE_REVIEWER_IDENTIFIER",
  "reviewedAt": "ACTUAL_ISO8601_TIME_WITH_TIMEZONE",
  "exceptions": []
}
```

Only confirmed **non-secret** findings can be excepted, using the private report's stable `Fingerprint`, `kind: "non-secret"` and a substantive `reason`. The digest-bound item review covers these exceptions. Do not except real credentials, unexplained findings, missing scans or timeouts.

If a valid credential was exposed, remove it from the candidate and revoke/rotate it through the appropriate private operational process. Deleting content alone does not resolve the incident. Keep invalidation evidence private.

## 5. Attach scope, incident, legacy and P0 evidence

Use `--plan-sha256` for `scopeSha256` below. It binds categories, locations, revisions, formats and expected bytes, excluding later review/evidence records to avoid circular hashes.

- `scopeReview`: `status: "approved"`, `scopeSha256`, `reviewer`, `reviewedAt`, and `omittedReasons` mapping each empty category to its actual reason.
- `credentialReview`: the same review fields plus `incidents`. An empty list explicitly confirms no known unresolved exposure in the scope. Each confirmed incident requires `status: "revoked"` or `"rotated"` and an `evidence` reference.
- `legacyReview`: the same review fields plus `clients`. Each legacy client needs its own review fields and `authority: "scoped"`, `"revoked"` or `"owner-approved-global"`. Global clients remain trusted Owner equivalents, without resource isolation.
- `gates.security` and `gates.release`: references such as `{"path":"private-evidence.json","sha256":"EXACT_EVIDENCE_FILE_HASH"}`. Credential invalidation uses the same reference format.

Each private evidence file is JSON with `status: "passed"`, matching `scopeSha256`, and a `checks` object. All required check names must have value `"passed"`. Missing, pending, failed, stale or changed evidence blocks readiness.

| Gate | Required checks |
| --- | --- |
| security | `unauthenticated`, `expiry`, `revocation`, `cross-principal`, `cross-engine`, `cross-workspace`, `read-only`, `workspace-containment`, `process-opt-in`, `restricted-execution`, `tls`, `log-redaction`, `package-integrity`, `recovery` |
| release | `licenses`, `source-provenance`, `platforms`, `checksums`, `workflow-isolation` |
| credential-disposition | `credential-invalidated` |

Include actual commits, tool/environment versions, dates, results and private supporting report links in the evidence files. Never label an unrun check as passed. Run the verifier again after adding reviews. Changed scope/content/evidence requires new matching verification.

## 6. Review before publication, then verify after publication

Passing this local gate means **ready for publication review**, not that a Release has been published. Pushing references, publishing official releases, changing repository visibility or history, changing production services and rotating credentials are separate explicit operational steps. A source export does not remove old public references or platform caches; review retained history and assets explicitly.

Before publishing, identify the approved public source revision and bind builds to it. Preserve Apache-2.0, attribution and actual third-party notices. Do not publish unreviewed extra branches, tags, attachments or build contexts. Rewriting old history or migrating historical distributions requires a separate reviewed plan; existing Engine/Gateway distribution repositories remain available.

After publication, verify anonymous access to intended source/history and the private security-reporting channel. Download **every** release asset and verify each image digest against the approved build manifest, including version/platform/notices. Unavailable or mismatching items remain incomplete. Do not delete or silently overwrite published versions to make acceptance appear successful.
