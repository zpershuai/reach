# Tasks

## 1. Shared packaging scripts

- [x] 1.1 Extract Engine packaging from `scripts/verify-packaging.sh` into `scripts/package-engine.sh` that builds `engine-linux-x64-musl` (static musl) and, on Darwin, `engine-darwin-arm64` or `engine-darwin-x64`; verify `--version` equals the Cargo package version and `file` still reports a statically linked musl binary on Linux.
- [x] 1.2 Extract Gateway packaging into `scripts/package-gateway.sh` that builds `packages/reach-rpc/dist`, produces `gateway-amd64.tgz` (`dist` + `deploy/compose.yaml` + `deploy/Dockerfile.gateway`), and builds the amd64 Gateway image; verify image and tarball `node dist/gateway-main.js --version` equal `packages/reach-rpc/package.json` version.
- [x] 1.3 Point `scripts/verify-packaging.sh` at those scripts, keep the OpenWrt Node bundle smoke, and add a dry-run that writes `SHA256SUMS` for the named Engine/Gateway assets without calling `gh release` or `docker push`; verify `bash scripts/verify-packaging.sh` still passes on Linux x86_64.
- [x] 1.4 On the macOS CI verify job, after `scripts/verify.sh`, build the native Engine via `scripts/package-engine.sh` (or equivalent cargo invocation) and assert `--version` matches Cargo; verify the job fails if that binary is missing.

## 2. Tag-triggered GitHub Release

- [x] 2.1 Add `.github/workflows/release.yml` on `push` tags `engine-v*` and `gateway-v*` that parses `{component, version}` and fails when the tag SemVer does not match Cargo (Engine) or Gateway `package.json`; verify a dry workflow run / unit of the parse script rejects `gateway-v0.3.2` against version `0.3.1`.
- [x] 2.2 Engine release jobs: matrix native `macos-14` (arm64) and `macos-15-intel` (x64) plus Ubuntu musl, upload `engine-darwin-arm64`, `engine-darwin-x64`, `engine-linux-x64-musl`; a publish job `needs` all three and fails if any asset is absent.
- [x] 2.3 Gateway release job: run packaging, push `ghcr.io/<owner>/reach-gateway:<X.Y.Z>` with `GITHUB_TOKEN`, and attach `gateway-amd64.tgz`; verify the workflow does not push on non-tag `verify.yml` runs.
- [x] 2.4 Generate Release notes from `git log` since the previous same-prefix tag (or repo root), filter subjects/bodies that look like `.reach/`, `*.env`, or `user@host`, attach `SHA256SUMS`, and create the GitHub Release with `softprops/action-gh-release`; verify a fixture changelog omits a fake SSH inventory line and includes intervening commit subjects.
- [x] 2.5 Keep `.github/workflows/verify.yml` as the `push`/`pull_request` gate with no `gh release` / GHCR publish steps; verify the workflow YAML contains no publish actions.

## 3. Engine update policy and GitHub client

- [x] 3.1 Extend `EngineConfig` with optional `REACH_UPDATE_ENABLED`, `REACH_UPDATE_REPO`, `REACH_UPDATE_INTERVAL_SECS` (default 3600, min 60), token/`_FILE`, `REACH_UPDATE_BACKEND` (`host` default, or `compose`), and `REACH_UPDATE_REQUEST_DIR` (required for `compose`); verify omitted keys still parse existing env, enabled+invalid interval/repo/backend fails before heartbeat, and `REACH_UPDATE_ENABLED` other than `1`/`true` stays disabled.
- [x] 3.2 Implement a GitHub Releases client over existing `ureq` rustls: paginated `/releases`, keep non-draft non-prerelease `engine-vX.Y.Z`, pick highest SemVer, User-Agent `reach-engine/<version>`; verify fixtures where equal/older is ignored, prerelease is ignored, and a newer tag is selected.
- [x] 3.3 Map `uname` to asset names (`linux`+`x86_64` including OpenWrt musl → `engine-linux-x64-musl`; Darwin arm64/x64 as named) and parse `SHA256SUMS`; verify unknown platform returns a typed error without downloading.

## 4. Engine idle apply

- [x] 4.1 Drive version checks from `Heartbeating` / `Waiting` / `Backoff` on the update interval without occupying the Runtime's heartbeat or session slot; verify a failed GitHub call backs off the updater only and the next Gateway `/heartbeat` still runs on `intervalSeconds`.
- [x] 4.2 Host backend: download to the same directory as `current_exe()`, verify digest and `--version`, `rename` onto the installed binary, chmod 755, keep `engine.prev`, update `~/.reach/versions.json` `engineVersion` when present; verify digest mismatch and version mismatch leave the previous bytes and the process continues.
- [x] 4.3 Refuse apply in `Connecting`, `ActiveSession`, and `Draining`; keep the update pending and retry after return to idle; verify `step()` tests for skip-during-session and apply+`Shutdown` from `Heartbeating`.
- [x] 4.4 On successful host apply enter `Shutdown` and exit 0 so LaunchAgent/systemd/procd start the new inode; verify the process does not `execve` in-place and does not resume session context.
- [x] 4.5 Compose Engine backend: when idle, write `request.json` (`component`, `version`, `asset`, `digest`, `repo`) under `REACH_UPDATE_REQUEST_DIR` and do not open Docker; verify no request file is written while a session is live, and acknowledge the helper only when idle while deferring new heartbeat leases until apply completion or expiry.

## 5. Gateway checker and host helper

- [x] 5.1 Parse the same `REACH_UPDATE_*` env in Gateway startup; fail before `listen` when enabled config is invalid; verify default (no keys) never fetches GitHub.
- [x] 5.2 Add a timer that lists Gateway Releases, compares SemVer to `GATEWAY_VERSION`, and treats only a strictly newer `gateway-vX.Y.Z` as available; verify mock `fetch` cases for newer / equal / older / HTTP error (listener stays up).
- [x] 5.3 Gateway idle means every registered Engine session is `none`; when idle and a newer Release is known, write `request.json` under `REACH_UPDATE_REQUEST_DIR`; verify a wanted or live Engine defers the write; acknowledge a prepared helper apply only when all Engines are idle and defer new REST/MCP session opens until completion or expiry.
- [x] 5.4 Add `scripts/apply-gateway-release.sh` that reads `request.json`, prefers `docker pull ghcr.io/<owner>/reach-gateway:<version>` then retags `reach-gateway:current` (keeping `reach-gateway:previous`), otherwise verifies `gateway-amd64.tgz` and extracts without overwriting `gateway.env` / `engines.json`, then obtain a nonce-bound, expiring idle acknowledgement before retag/recreate with `docker compose up -d`; release admission on success/failure/timeout; verify a python fake-docker test like `test-engine-linux-installer.py` covers pull, tarball, digest mismatch, and preserved env files.
- [x] 5.5 Document and ship a Compose `updater` sidecar (or systemd path unit) that mounts `docker.sock` only on the sidecar and the shared request dir; Gateway service stays read-only, unprivileged, no socket; verify `deploy/compose.yaml` Gateway service still has `read_only`, `cap_drop: ALL`, and no `docker.sock`.
- [x] 5.6 Add `scripts/apply-engine-release.sh` for Docker Engine containers that recreates the Engine service from the musl (or matching) image/binary while keeping env and workspace mounts; prepare and verify the image before obtaining the same idle handshake; verify the fake-docker test does not drop those mounts and does not recreate without idle acknowledgement.

## 6. Docs and operator configuration

- [x] 6.1 Update `docs/deploy/versions.md` with tag names, asset names, checksums, opt-in env, idle-only apply, and that Node runtime is not replaced; use reserved example domains only.
- [x] 6.2 Update `docs/deploy/operations.md` (and gateway/engine/linux/openwrt as needed) with helper install, Compose request-dir mount, `engine.prev` / `reach-gateway:previous` rollback, and that apply still drops in-memory sessions; verify no real SSH targets or tokens appear.
- [x] 6.3 Document optional `REACH_UPDATE_*` in `docs/deploy/configuration.md` as omitted-safe; verify existing env examples still start Gateway/Engine without those keys.

## 7. Integration verification

- [x] 7.1 Run `bash scripts/verify.sh` and, on Linux x86_64, `bash scripts/verify-packaging.sh`; both must pass.
- [x] 7.2 Run focused Engine runtime tests for update skip/apply/digest/GitHub-failure and Gateway tests for idle write / busy defer / disabled no-fetch, plus prepared-then-idle Compose handshake, session admission, expiry and helper timeout; they must pass under the existing `cargo test` / `packages/reach-rpc` test commands.
- [x] 7.3 Confirm public docs, workflow YAML, and generated changelog fixtures contain no private inventory from `.reach/`.
