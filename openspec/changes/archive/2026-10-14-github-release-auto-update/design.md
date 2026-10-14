# Design

## Context

See proposal.md for motivation. Current constraints that shape the approach:

- CI is `.github/workflows/verify.yml` only: Linux/macOS `scripts/verify.sh` plus a Linux packaging job that builds a throwaway musl Engine and `reach-gateway:verification` image. Nothing is uploaded. There are no git tags.
- Versions already exist and are independent: Engine `CARGO_PKG_VERSION`, Gateway `packages/reach-rpc/package.json` → `dist/version.json`. Query surfaces (`--version`, `/healthz`, heartbeat, `session.ready`, `get_versions`) stay as they are.
- Gateway production is a read-only, `cap_drop: ALL`, non-root Compose service. It cannot talk to the Docker socket or rewrite `/app`. Host files that must survive an update are `gateway.env` and `engines.json`.
- Engine is a host binary under LaunchAgent, systemd, or OpenWrt procd, or in some installs a Docker container. Supervisors restart on exit. Sessions are in-memory and non-resuming; an apply is a new process and a new Agent open.
- Engine HTTP is `ureq` + rustls, outbound only, pinned to one Gateway. Auto-update adds a second outbound origin (GitHub) that must not steal the heartbeat or session slot.
- Public docs and Release notes must stay free of private hosts and tokens (`AGENTS.md`).

## Goals / Non-Goals

**Goals:**

- One tag-triggered workflow that turns `engine-vX.Y.Z` / `gateway-vX.Y.Z` into a GitHub Release with named, checksummed assets and commit-range notes.
- Shared packaging scripts so the existing packaging job can build the same Engine/Gateway artifacts without publishing.
- Opt-in in-process version checks on Engine and Gateway, SemVer-only, idle-only apply, failed verify leaves the old artifact running.
- Engine host-binary apply by atomic replace + exit 0. Docker Engine and Gateway apply through a host helper, never from inside the read-only/unprivileged container.
- Existing installs keep working with auto-update omitted.

**Non-Goals:**

- Publishing on every `main` push, or using `/releases/latest` (that is one repo-wide latest, not per component).
- MCP stdio Connector auto-update, Windows Engine, linux-arm64 Engine, crates.io/npm publish.
- Replacing the pinned Node runtime as part of an Engine/Gateway update.
- In-session forced upgrade, session resume after apply, or Gateway proxying GitHub for Engines (Engines that cannot reach GitHub do not auto-update).
- Mounting `docker.sock` into the Gateway container.

## Decisions

### 1. Tags are the only publish trigger; verify stays on every push

Keep `verify.yml` as the PR/push gate. Add `.github/workflows/release.yml` on `push` tags `engine-v*` and `gateway-v*`.

The release workflow:

1. Parses the tag into `{component, version}`.
2. Fails if `engine-vX.Y.Z` ≠ Cargo package version or `gateway-vX.Y.Z` ≠ Gateway `package.json` version.
3. Runs the same verify/packaging commands as CI (or `needs` equivalent jobs).
4. Builds assets via `scripts/package-engine.sh` / `scripts/package-gateway.sh` (extracted from `verify-packaging.sh` so packaging CI and release share one implementation).
5. Writes notes from `git log` since the previous tag with the same prefix; if none, from the root commit. A small filter drops lines that look like private inventory (`.reach/`, `*.env`, SSH `user@host`). Conventional-commit grouping is optional, not required.
6. Uploads assets + `SHA256SUMS` with `softprops/action-gh-release`. Gateway also `docker push`es `ghcr.io/<owner>/reach-gateway:<version>` (and the tag name) using `GITHUB_TOKEN`.

Ordinary packaging CI builds the musl Engine and Gateway image as today, plus a dry-run that asserts asset names and `--version`, and must not call `gh release` / `docker push`.

**Why not publish on every main commit:** independent SemVer already exists; auto-update compares SemVer, not SHAs. **Why not “version file changed on main”:** tags make the Release identity explicit and stop accidental publishes from lockfile-only commits.

### 2. Asset names are stable and platform-explicit

| Asset | Produced on | Used by |
| --- | --- | --- |
| `engine-linux-x64-musl` | ubuntu + musl-gcc | systemd Linux and x86_64 musl OpenWrt (same static binary) |
| `engine-darwin-arm64` | `macos-14` | macOS LaunchAgent on Apple Silicon |
| `engine-darwin-x64` | `macos-15-intel` | macOS LaunchAgent on Intel |
| `gateway-amd64.tgz` | ubuntu | host helper: `dist` + `deploy/compose.yaml` + `deploy/Dockerfile.gateway` |
| `SHA256SUMS` | same jobs | every updater |
| GHCR `reach-gateway:<X.Y.Z>` | ubuntu | Compose pull path |

Engine `--version` / Gateway image `--version` must equal the tag SemVer. linux-arm64 is not a required asset (no installer target). OpenWrt Node bundles stay in the packaging smoke job; they are not Engine auto-update assets.

macOS binaries come from native runners rather than Linux cross-compile. The Engine release job is a matrix; the GitHub Release is created once after all artifacts exist (`needs` + a publish job).

### 3. Version discovery lists component tags, not `/releases/latest`

Updater calls `GET /repos/{owner}/{repo}/releases` (paginated, modest cap), keeps non-draft non-prerelease tags matching `engine-vX.Y.Z` or `gateway-vX.Y.Z`, and picks the highest SemVer. Compare is strict `major.minor.patch`; pre-release tags are ignored. Equal or older → no-op.

`REACH_UPDATE_REPO` (`owner/repo`) is required when auto-update is enabled so public code does not hard-code a private owner. Optional `REACH_UPDATE_GITHUB_TOKEN` or `REACH_UPDATE_GITHUB_TOKEN_FILE` for private repos and rate limits. User-Agent is `reach-engine/<version>` or `reach-gateway/<version>` (GitHub requires one). Default check interval 3600s, minimum 60s. Failed HTTP → updater-only backoff (1s doubling to 60s, same shape as Engine heartbeat backoff), Gateway/Engine data plane unchanged.

Engine uses existing `ureq` rustls; Gateway uses `fetch`. No new HTTP stack.

### 4. Check in-process; apply is a backend, not `docker` from the payload container

**Engine host (`REACH_UPDATE_BACKEND=host`, default):**

On `Heartbeating` / `Waiting` / `Backoff` only, after a successful check that found a newer SemVer:

1. Resolve asset name from `uname` (`linux`+`x86_64` → `engine-linux-x64-musl`; `darwin`+`arm64`/`x86_64` as above). OpenWrt musl x86_64 uses the Linux musl asset.
2. Download to a temp file in the same directory as `current_exe()`, verify SHA-256 against `SHA256SUMS`, run `--version`.
3. `rename` over the installed binary (same inode-replace pattern as the Linux installer), chmod 755, update `~/.reach/versions.json` `engineVersion` when that file exists.
4. Enter `Shutdown` and exit 0. LaunchAgent / systemd / procd start the new inode.

Refuse apply in `Connecting` / `ActiveSession` / `Draining`. Record pending and retry on the next idle wait. The GitHub call is not the Runtime’s one heartbeat or session transport (injected client in tests, same style as `FakeHeartbeat`).

**Gateway and Docker Engine (`compose` backend):**

The process never opens Docker. Compose gains a bind-mounted writable directory (example `/run/reach/update`, host `deploy/update/`). When idle and a newer Release is verified by metadata (tag + asset digest listed), Gateway writes `request.json` (`component`, `version`, `asset`, `digest`, `repo`) and logs. A host helper shipped in the Gateway tarball (`scripts/apply-gateway-release.sh`) is armed once by the operator as a systemd path unit (Linux VPS) or a Compose `updater` **sidecar** that mounts `docker.sock` **only on that sidecar**, not on `gateway`.

The helper:

1. Reads `request.json`.
2. Prefers `docker pull ghcr.io/<owner>/reach-gateway:<version>` when registry auth exists; otherwise downloads `gateway-amd64.tgz`, verifies digest, extracts `dist` / Dockerfile / compose over the release directory **without** overwriting `gateway.env` or `engines.json`.
3. Downloads/pulls, verifies digest and version, and prepares the image before requesting idle admission. No running container is changed during this phase.
4. Atomically writes `apply.json` containing the request identity, a random nonce and a bounded expiry. The process keeps existing sessions running, temporarily defers new session opens/leases, and writes matching `idle.json` only when fully idle. Gateway admission covers REST and MCP for every registered Engine. Docker Engine admission survives supervisor/container restart through the shared directory.
5. Rechecks the matching idle acknowledgement and the unexpired apply intent, then retags `reach-gateway:current` and runs `docker compose up -d --no-build`. Missing acknowledgement or timeout leaves the old container running.
6. Writes `result.json` and deletes the successful request. Removes `apply.json` and `idle.json` on completion/failure; expiry also releases admission if the helper crashes. Requests without a ready helper never reserve admission.

Gateway idle means every registered Engine is session `none` (not wanted/pending/connecting/ready/closing). Docker Engine idle is the same Engine-state rule as host Engine; its helper recreates the Engine container and keeps env/workspace mounts.

If the helper is not installed, the process only logs “update available” and remains on the current artifact — still a correct check timer.

### 5. Configuration is fail-fast and omitted-safe

Engine (extend `EngineConfig::parse_from_env`):

| Variable | Default | Notes |
| --- | --- | --- |
| `REACH_UPDATE_ENABLED` | unset/false | any other value than `1`/`true` is disabled |
| `REACH_UPDATE_REPO` | required if enabled | `owner/repo` |
| `REACH_UPDATE_INTERVAL_SECS` | 3600 | positive integer, min 60 |
| `REACH_UPDATE_GITHUB_TOKEN` / `_FILE` | unset | optional |
| `REACH_UPDATE_BACKEND` | `host` | `host` or `compose` |
| `REACH_UPDATE_REQUEST_DIR` | required if `compose` | writable dir |

Gateway uses the same names (and `REACH_UPDATE_REQUEST_DIR` required when enabled). Invalid enabled config fails before listen/heartbeat. Existing `engine.env` / `gateway.env` without these keys is unchanged.

### 6. Tests reuse injected clocks and HTTP, not live GitHub

- Engine: fake Releases client + fake apply backend; `step()` tests for pending during `ActiveSession`, apply+Shutdown from `Heartbeating`, digest mismatch leaves exe, GitHub error still heartbeats.
- Gateway: `withGateway` + mock `fetch`; busy engine defers write of `request.json`; idle writes it; disabled never fetches.
- Packaging: extend `verify-packaging.sh` (or the extracted scripts) to assert asset names and `--version`. macOS job already builds Engine; assert `--version` equals Cargo.
- Helper: python tests with fake `docker` like `test-engine-linux-installer.py`.
- No workflow that creates a real Release from PR CI.

## Risks / Trade-offs

- [Read-only Gateway cannot self-replace] → Check in-process, apply on the host helper/sidecar. Document that enabling Gateway auto-update means installing that helper once; without it, checks still run and apply does not.
- [Docker.sock is root-equivalent] → Never mount it on the Gateway service. Optional sidecar is explicit and separate from the public control plane.
- [Engine devices without GitHub egress] → Direct Releases API as specified; no Gateway proxy in this change. Operators on isolated LANs leave auto-update off and keep the manual installer path.
- [macOS x64 runner drift] → Pin `macos-15-intel` for x64 and `macos-14` for arm64; if GitHub retires macos-15-intel, the Engine Release job fails rather than silently dropping an asset.
- [Replacing a running binary] → Rename onto a new inode then exit; supervisors already restart. Do not `execve` the new binary in-process (session state, open sockets, LaunchAgent KeepAlive semantics).
- [Unauthenticated GitHub rate limit] → Default interval 1h, optional token, updater-only backoff. Many engines sharing one public IP may still need a token.
- [Partial matrix failure] → Publish job waits for every required asset; missing macOS binary fails the Release instead of shipping Linux-only.
- [Changelog leaking inventory] → Generate from git subjects/bodies with a denylist; review still required for the first few tags.
- [Compose recreate drops Gateway memory] → Idle-only apply; clients reopen sessions. Same as today’s manual Gateway upgrade.

## Migration Plan

1. Land packaging script extraction and workflow behind tags; no running install changes.
2. Push the first `engine-v…` / `gateway-v…` tags after bumping manifests if needed (current Engine `0.2.1`, Gateway `0.3.1` can be the first published tags of those versions, or bump patch).
3. Ship Engine/Gateway check+apply code with auto-update **off**. Installers and `docs/deploy/versions.md` / `operations.md` document env, asset names, helper unit, and rollback (retag previous image / restore previous binary from existing backup dirs).
4. Operators who want it: set `REACH_UPDATE_*`, install the Gateway helper on the VPS, recreate Compose once to mount `update/`, restart Engines to pick up env. Do not edit public docs with real SSH targets.

Rollback of a bad auto-applied Engine: supervisor still points at the replaced file; use the existing backup directories from installers / `operations.md` (`~/.reach/backups`, `/root/.reach/backups`) or keep the previous inode next to the binary as `engine.prev` on successful apply (helper/host backend does this). Gateway helper keeps `reach-gateway:previous` tag before retagging `current`.

## Open Questions

- Whether the first published tags reuse `0.2.1` / `0.3.1` or bump patch solely to mark “first GitHub Release” can be decided at apply time; auto-update only cares that tag SemVer matches the artifact.
