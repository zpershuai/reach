# Component release procedure

This procedure prepares and verifies candidates. Publishing source, creating official tags, configuring credentials and publishing a Release are separate maintainer operations. Keep inventories, reports, review identities and private revision mappings in ignored `.reach/` or outside the repository. Preserve existing installations and private history. Follow the [publication checklist](publishing-checklist.md) before choosing a source snapshot.

## Source and distribution identities

A source repository and separate Engine/Gateway distribution repositories may be used. `example/reach-source`, `example/reach-engine` and `example/reach-gateway` below are placeholders, not verified repositories. A binary repository is not a substitute for publicly accessible matching source.

Official metadata generation requires an unchanged checkout whose HEAD equals the supplied full public revision. It anonymously checks the GitHub repository and that exact commit. It refuses private or unavailable source. Do not substitute a private revision or a private-to-public mapping. The tag must match the component manifest. A clean export from the original private repository requires its own approved public commit before this step.

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

Generate metadata for the selected component (replace the tag and placeholder repository):

```bash
public_revision="$(git rev-parse HEAD)"
python3 scripts/release-metadata.py manifest engine-v0.3.1 .reach/release \
  --source-repository example/reach-source --source-revision "$public_revision" \
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

Set repository variables to approved actual targets. Do not put deployment details in these public examples:

| Variable / secret | Purpose |
| --- | --- |
| `REACH_SOURCE_REPOSITORY` variable | Exact public source owner/repository; release workflow ignores other repositories |
| `REACH_ENGINE_RELEASE_REPOSITORY`, `REACH_GATEWAY_RELEASE_REPOSITORY` variables | Exact public binary repositories; no implicit private-source fallback |
| `REACH_APPROVED_CANDIDATE_SHA256` environment variable | Reviewed digest printed by the candidate gate, bound to exact manifest and optional image archive |
| `REACH_PUBLIC_RELEASE_TOKEN` environment secret | Fine-grained contents write only for approved distribution repositories; no source administration permission |
| `REACH_GATEWAY_IMAGE_REPOSITORY` variable | Optional `ghcr.io/<approved-owner>/<approved-image>`; empty disables image publication |
| `REACH_GHCR_PUBLISH_TOKEN` secret and `REACH_GHCR_USER` variable | Optional package publishing identity limited to the approved image target |

Protect the `public-release` environment with required reviewers, restricted component tags and no unreviewed bypass. Review the actual candidate digest after build before approval. Verify those remote settings and token scopes privately; YAML cannot enforce remote settings or prove credentials exist. Build/verify/candidate jobs use read-only repository permissions and receive no cross-repository or registry credentials. Do not use `pull_request_target` to build untrusted code with secrets.

### Minimal configuration plan (requires separate approval)

Preparing this plan does not authorize changing repository settings, creating an environment or storing credentials. Leave the source-repository variable unset until the public source identity and release targets are approved: setting it allows matching future tag pushes to enter the release workflow. A missing variable intentionally skips release jobs; it is not a reason to remove that guard.

1. **Approve public source first.** Export and review a clean snapshot following the [publication checklist](publishing-checklist.md). Keep the original private history private. Identify the actual public source repository and full commit; the manifest generator verifies both anonymously. Pointing the variable at a private repository cannot satisfy this gate.
2. **Set only target variables on that approved source repository.** Configure `REACH_SOURCE_REPOSITORY`, `REACH_ENGINE_RELEASE_REPOSITORY` and `REACH_GATEWAY_RELEASE_REPOSITORY` to the approved repositories. These identify public source and distribution destinations; they contain no credentials. Do not enable the optional image target for a tarball-only release.
3. **Create the protected environment on that source repository.** After explicit approval, create `public-release` with required reviewers, prevent self-review and unreviewed bypass where supported, and restrict deployment to `engine-v*` and `gateway-v*` tags. Check that the account plan supports the intended protections before enabling publication. Ordinary branch pushes and PRs must continue to verify without publisher credentials.
4. **Prepare a dedicated distribution credential.** Use an expiring fine-grained PAT or GitHub App installation token restricted to the two approved distribution repositories, with **Contents: read and write** and the implicit metadata read access. No source-repository access, administration, Actions, secrets or workflow-write permission is required for this publisher's releases targeting each distribution repository's existing default branch. Keep credentials that can change workflow files out of this role. Store the dedicated credential only as the environment secret `REACH_PUBLIC_RELEASE_TOKEN`, after separate approval; never copy a maintainer's broadly scoped CLI token into Actions. The current secret name is `REACH_PUBLIC_RELEASE_TOKEN`, not the old `PUBLIC_RELEASE_TOKEN`.
5. **Approve exact bytes per candidate.** Build and inspect the candidate and complete publication inventory before setting the environment variable `REACH_APPROVED_CANDIDATE_SHA256` to the reviewed digest. That value grants publication of those exact bytes; it is neither a standing approval for later builds nor a substitute for environment review. Changed bytes require a new review and digest.

Keep `REACH_GATEWAY_IMAGE_REPOSITORY`, `REACH_GHCR_PUBLISH_TOKEN` and `REACH_GHCR_USER` unset for the minimum tarball-only configuration. Container publication needs a separate image/layer and permission review. A fine-grained Contents token is not a GHCR credential: GitHub documents registry authentication separately, including workflow `GITHUB_TOKEN` and PAT (classic) package scopes. The current optional secret-based path must use a dedicated identity and the minimum supported package scope, without broad `repo` or `delete:packages` access. Switching to a workflow token with package write would itself require a separately approved workflow and package-permission change.

Read-only diagnosis may list variable names, target values, environment protection metadata and secret **names**, never secret values. Repository admin/push access does not prove a release credential exists or has the required restricted scope. A missing/inaccessible protected environment, unavailable public source, absent secret or unmatched candidate approval remains incomplete; do not enable permissive defaults to work around it.

Permission references: [Release API token permissions](https://docs.github.com/en/rest/releases/releases#create-a-release) and [Container registry authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#authenticating-to-the-container-registry).

Ordinary pushes/PRs verify only. `workflow_dispatch` creates a dry-run candidate. Only a trusted tag push on the configured source repository, descended from its default branch, can reach publish after all gates pass. Upload paths are explicit allowlists. The publisher checks candidate approval before network mutations, refuses any existing Release or distribution tag, creates a draft with exact files, then publishes and downloads it again. GHCR is pushed only from the reviewed image archive in the publisher; the final manifest includes its immutable digest reference.

A failure after creation can leave a draft, published Release or image requiring investigation. Do not automatically delete, retag or overwrite it. Diagnose privately and use a reviewed new version if needed. SHA-256 protects against changed bytes within this approved HTTPS/write-access trust channel; publisher signatures remain future work.

## Independent download acceptance

Keep the approved build manifest locally, then run this read-only command without a GitHub token:

```bash
python3 scripts/verify-release-download.py .reach/release/release-manifest.json \
  --repository example/reach-engine --tag engine-v0.3.1 \
  --report .reach/publication/release-readback.json
```

Use the Gateway repository/tag for Gateway. The command enumerates the remote inventory, requires the exact approved file set, downloads every file anonymously, checks byte counts/hashes, validates the embedded versions/platforms/licenses, checks the public source revision, and verifies optional GHCR manifest bytes against their approved digest. A missing/duplicate/extra attachment, wrong content, inaccessible source/image or last-asset timeout remains incomplete. The command never modifies a Release. Loopback HTTP is accepted only with explicit `--test-mode --api-origin` for synthetic tests; it is not an official acceptance result.

After publication separately verify anonymous source/history visibility, security reporting and all intended retained distributions. Record actual results privately; preparing a candidate does not mean source has been published.
