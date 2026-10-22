# Component release procedure

This procedure prepares and verifies candidates. Creating official tags, configuring release approval and publishing a Release are separate maintainer operations. Keep inventories, reports and review identities in ignored `.reach/` or outside the repository. Preserve existing installations. Follow the [publication checklist](publishing-checklist.md) before choosing a source snapshot.

## Source and distribution identities

Source and both components' new releases live in [zpershuai/reach](https://github.com/zpershuai/reach/releases). Engine and Gateway retain separate `engine-vX.Y.Z` and `gateway-vX.Y.Z` tags and asset sets. Do not merge the two components into one Release or use GitHub's repository-wide latest-release shortcut to select a component.

The old [Engine](https://github.com/zpershuai/reach-engine/releases) and [Gateway](https://github.com/zpershuai/reach-gateway/releases) distribution repositories and their published versions remain available. No history or assets are migrated, overwritten or deleted by this workflow. Existing explicit `REACH_RELEASE_REPO` and `REACH_UPDATE_REPO` settings keep their meaning; change them to `zpershuai/reach` when an installation should follow new releases. Nothing rewrites running installations' configuration.

Official metadata generation requires an unchanged checkout whose HEAD equals the supplied full public revision. It anonymously checks the GitHub repository and that exact commit. It refuses private or unavailable source, including an anonymous API rate limit. The tag must match the component manifest. For publication the existing tag must resolve to that exact revision, including annotated tags; a missing or mismatched tag fails before any Release is created.

Use the exact versions in `scripts/toolchain.json`, npm lockfiles and Cargo.lock. CI pins identify the verification environment, not a promise that every older supported host uses those versions.

## Build and assemble

Engine builds run on Linux x64 with musl-tools, macOS arm64 and macOS Intel. On each native runner:

```bash
bash scripts/package-engine.sh .reach/platform-output
```

Transfer only that runner's `engine-<platform>`, `.NOTICES.txt` and `.licenses.tgz` into a new empty `.reach/release/`. Retain all three platform sets, then run:

```bash
python3 scripts/merge-engine-notices.py .reach/release
```

Gateway uses Linux amd64 Docker and locked npm dependencies:

```bash
npm --prefix packages/reach-rpc ci --ignore-scripts
bash scripts/package-gateway.sh .reach/gateway-build reach-gateway:candidate
mkdir .reach/release
cp .reach/gateway-build/gateway-amd64.tgz .reach/gateway-build/LICENSE \
  .reach/gateway-build/THIRD_PARTY_NOTICES.txt \
  .reach/gateway-build/third-party-licenses.tgz .reach/release/
docker save --output .reach/gateway-image-build.tar reach-gateway:candidate
```

Keep build directories, unpacked LICENSES trees and image build archives out of the publishable directory. Exact allowlists reject extra files, not just missing files. Do not combine Engine and Gateway into one component Release.

Generate metadata for the selected component (replace the tag with the manifest version):

```bash
public_revision="$(git rev-parse HEAD)"
python3 scripts/release-metadata.py manifest engine-v0.3.2 .reach/release \
  --source-repository zpershuai/reach --source-revision "$public_revision" \
  --toolchain scripts/toolchain.json
python3 scripts/verify-release-assets.py complete .reach/release
```

The manifest contains component/version, public source repository/revision/URL, exact Rust/Node/Python identifiers, explicit OS/CPU/format records and every asset's bytes/SHA-256. SHA256SUMS additionally covers the manifest. Metadata cannot contain extra private mapping fields. Engine notices bind each executable to its version and compiler; Gateway checks its embedded package version, Node/npm/font notices and matching tar contents. Missing platform declarations, mismatched versions/digests and unapproved attachments fail.

## Candidate gates and review

Run `bash scripts/verify.sh` and Linux `bash scripts/verify-packaging.sh`. Release calls the same reusable CI verification workflow. Only the native platform job executes its Engine version probe; cross-platform header checks do not replace native execution.

```bash
python3 scripts/install-publication-tools.py
python3 scripts/prepare-public-source.py --revision "$public_revision" \
  --output .reach/public-candidate --record .reach/publication/source-export.json
python3 scripts/release-plan.py prepare .reach/release --record .reach/candidate.json \
  --source .reach/public-candidate
python3 scripts/publish-release.py .reach/release --record .reach/candidate.json
```

For Gateway add `--image-archive .reach/gateway-image-build.tar` to the last two commands. The plan scans the exported source, all candidate files and every image layer. Findings or incomplete scanning block the candidate. The last command is a dry run: it validates and prints a candidate digest without release credentials or publishing commands.

A digest alone is not human approval. Review the exact candidate plus the complete publication inventory, including continuing Git history, old attachments and old image layers. Candidate scanning does not replace the checklist's scope, credential-disposition, legacy-client and P0 evidence gates. Private reports must not be uploaded as public CI artifacts. Changed bytes require a new review and candidate digest.

## CI configuration and publication permissions

The workflow derives candidate source identity from `github.repository`. It needs no source/target repository variables or cross-repository PAT. Official publication is restricted to `zpershuai/reach`; forks may build candidates but cannot enter the official publisher.

The only write permission declared in the workflow is **`contents: write` on the `publish` job**. All version, verification, build and candidate jobs inherit `contents: read`. The publisher receives the automatic, repository-scoped, short-lived `github.token` as `GH_TOKEN`; it is not a manually stored secret. Checkout does not persist that publishing credential. No Actions, administration, workflow-write or package-write permission is requested, and no broad default workflow permission change is needed. The old source/target variables and dedicated release PAT are no longer used.

Two approval controls remain:

| Control | Purpose |
| --- | --- |
| `public-release` environment | Required reviewers, component-tag restrictions and no unreviewed administrator bypass |
| `REACH_APPROVED_CANDIDATE_SHA256` environment variable | Reviewed digest printed by the candidate gate, bound to the exact manifest and optional scanned image archive |

Configure the protected environment **before the first official tag run**. Otherwise GitHub can create an unprotected environment automatically. Select an actual trusted reviewer; preventing self-review requires someone other than the run's initiator to approve. Restrict deployment to tags `engine-v*` and `gateway-v*`, rather than branches. Build/verify/candidate jobs never reference the environment or publisher token. YAML alone cannot prove those remote protections exist, and preparing this change does not authorize creating or weakening them.

Ordinary pushes/PRs verify only. `workflow_dispatch` builds a candidate and uploads its explicit asset allowlist, but cannot publish a Release. Only a component tag push on the official repository, descended from its default branch, can reach publish after verification, candidate review, the exact digest and environment approval. Changed bytes require a new candidate review and digest. Do not use `pull_request_target` to build untrusted code with write authority.

For tag-triggered CI before merging a repair branch, create a **new** tag `engine-vX.Y.Z-ci.N` or `gateway-vX.Y.Z-ci.N`, where the component version matches its manifest and `N` is a unique positive integer (for example a UTC timestamp). The test commit must contain the current default branch. These explicit CI prerelease tags run the same verification, native component builds, packaging and candidate scans, and upload candidate artifacts. Their normalized manifest retains `X.Y.Z`, but `test_only=true` explicitly skips the protected publisher, regardless of credentials or approval settings. The strict official tag parser still rejects prerelease tags. Never move or reuse an existing test tag; use a new suffix for a retry. Ordinary stable tags still require their commit to be contained in the default branch.

The publisher refuses any existing Release (including drafts), verifies that the existing component tag resolves to the approved source revision, creates a draft with `--verify-tag`, then publishes and independently downloads the exact files. It never creates, moves or deletes a tag, and never replaces old Release assets. Do not rerun an old pre-fix tag to validate current main or move an existing version's tag to include new fixes; choose and review a new component version instead.

New Gateway releases ship `gateway-amd64.tgz` with the inputs for a local Docker build. The candidate container is still built and every layer scanned, but this workflow does not push to GHCR and needs no registry credentials or `packages: write`. Existing image references, checksums and the legacy download/readback paths remain supported. Container publication would require a separately reviewed change.

A failure after Release creation can leave a draft or published Release requiring investigation. Do not automatically delete, retag or overwrite it. Diagnose privately and use a reviewed new version if needed. SHA-256 binds the reviewed bytes; publisher signatures remain future work.

Permission references: [automatic token authentication](https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication), [Release API permissions](https://docs.github.com/en/rest/releases/releases#create-a-release), and [environment protection](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

## Independent download acceptance

Keep the approved build manifest locally, then run this read-only command without a GitHub token:

```bash
python3 scripts/verify-release-download.py .reach/release/release-manifest.json \
  --repository zpershuai/reach --tag engine-v0.3.2 \
  --report .reach/publication/release-readback.json
```

Use the same repository with `gateway-vX.Y.Z` for Gateway. For a retained legacy release, pass its original distribution repository and tag explicitly. The command enumerates the remote inventory, requires the exact approved file set, downloads every file anonymously, checks byte counts/hashes, validates the embedded versions/platforms/licenses, checks the public source revision, and verifies optional GHCR manifest bytes against their approved digest. A missing/duplicate/extra attachment, wrong content, inaccessible source/image or last-asset timeout remains incomplete. The command never modifies a Release. Loopback HTTP is accepted only with explicit `--test-mode --api-origin` for synthetic tests; it is not an official acceptance result.

After publication separately verify anonymous source/history visibility, security reporting and all intended retained distributions. Record actual results privately; preparing a candidate does not mean source has been published.
