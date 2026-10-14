# Proposal

## Why

Reach already versions Gateway and Engine independently and reports those versions, but shipping still means a local build, scp, and installer or Compose rebuild. CI only verifies; it never publishes GitHub Release assets, and neither process checks for a newer build. Operators cannot get a tagged, checksummed package onto a VPS Gateway or onto macOS, Linux, and OpenWrt Engines without repeating that manual path.

## What Changes

- Pushing a component SemVer tag (`engine-vX.Y.Z` or `gateway-vX.Y.Z`) runs a GitHub Actions workflow that verifies, builds platform artifacts, writes a changelog from commits since the previous matching tag, and publishes a GitHub Release with checksums. Ordinary `push` / `pull_request` still only run the existing verify and packaging jobs.
- Engine CI produces signed-off binaries for Linux x86_64 musl (systemd and OpenWrt), Linux arm64 where the toolchain allows, and macOS arm64/x64. Gateway CI produces the existing Docker image plus a release tarball of `dist` and Compose/Dockerfile files. Node runtime remains the separately pinned installer artifact; an Engine update does not replace Node unless a later change says so.
- Installed Gateway and Engine processes poll GitHub Releases on a timer, compare SemVer with the running component, and apply only while idle: Engine while not connecting/active/draining; Gateway only when no Engine has a wanted or live session. Apply uses the existing supervisor model (LaunchAgent, systemd, procd, or Docker Compose) so the process exits and the supervisor starts the new artifact. Failed verify or apply leaves the previous artifact running.
- Auto-update is opt-in via environment configuration, supports an optional GitHub token for private repositories and rate limits, and never writes private hostnames, tokens, or inventory into public docs or release notes.

## Capabilities

### New Capabilities

- `github-release-publish`: Tag-triggered GitHub Actions release for Gateway and Engine, including artifact naming, changelog, checksums, and tag-to-manifest version matching.
- `component-auto-update`: Idle-only version checks and apply backends for Gateway (Compose/image or release tarball) and Engine (host binary or Docker-managed Engine), including verification, pending-update behavior, and failure isolation.

### Modified Capabilities

- `deployment-verification`: CI must keep the existing Linux/macOS verify gate and packaging smoke, and must also build the named release assets used by auto-update (without requiring a tag on every push).
- `edge-engine-service`: Engine startup accepts update policy; idle heartbeat continues while a pending update waits; apply does not run during an active session.
- `engine-runtime`: Update apply is allowed only outside `Connecting` / `ActiveSession` / `Draining`; after a successful replace the process exits so the supervisor loads the new binary; session non-resumption still holds.

## Impact

- `.github/workflows`: add a tag-triggered release workflow; keep `verify.yml` as the PR/push gate.
- Engine: `crates/reach-rpc` gains a GitHub Releases client (existing `ureq` + rustls), update config, and an idle apply path that stages a verified binary then exits 0.
- Gateway: `packages/reach-rpc` gains a Node timer that checks GitHub Releases; because the production container is read-only and unprivileged, apply is a documented host helper or Compose sidecar, not an in-container `docker` client.
- Installers and Compose: optional update env, checksum verification, and Docker Engine/Gateway apply backends. Existing Linux installer recovery rules still apply when the Engine replace path reuses that staging logic.
- Docs: `docs/deploy/versions.md` and `operations.md` describe tag publish, idle auto-update, and rollback; no private deployment inventory.
- Not in this change: MCP stdio Connector auto-update, Windows Engine, crates.io/npm publish, changing `reach-rpc/1.0`, or forcing an in-session upgrade.
