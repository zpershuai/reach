# Deployment checklist

English | [简体中文](deployment-checklist_cn.md)

Use for any environment. Keep actual hosts, accounts, private addresses, inventories, service states, digests and backup locations in private storage such as ignored `.reach/`, never public documentation.

## Configuration and installation

- Configure Gateway HTTPS URL, Controller token and a unique token per Engine.
- Choose unique Engine IDs and explicit workspace boundaries.
- Check credential permissions, Git ignores and Docker context.
- Install target-architecture binaries and private Node runtime.
- Select LaunchAgent/systemd/procd and verify startup policy.
- Configure MCP aliases, engineId, Gateway URL and private device file.
- HTTP MCP uses HTTPS /mcp and private Controller token. Inspect actual client Origin: configure the observed complete REACH_MCP_ALLOWED_ORIGINS if present, otherwise leave empty. Never wildcard/disable checking or retain/publish Authorization while inspecting.

## Verification

- Gateway health reports expected protocol/component version.
- Reject unauthenticated/wrong-role requests.
- Every Engine opens and accesses its own workspace.
- Multiple Engines isolate sessions/grants/RPC.
- Reject workspace escapes; closing one device leaves others alone.
- Installed MCP lists/selects devices and queries versions.
- Generate a private HTTP plugin with full HTTPS URL, run verifier, then check private token storage, Origin, discovery and known-file reading in actual host (e.g. Grok Bot). For interactive usage verify loaded 15-second Gateway heartbeat.
- Close sessions created by verification.

See [Verification](verification.md). Test files/reports remain private; public records describe reusable features/results only.

## Upgrade and recovery

- Back up programs, configuration, registry and workspaces first.
- Record target versions/digests and retain recoverable previous artifacts.
- Recheck real file RPC after upgrades; verify process recovery in maintenance as needed.
- Check configuration compatibility during rollback; restore workspace files separately.

See [Operations](operations.md).

## Automated verification and platform coverage

- Linux/macOS CI bash scripts/verify.sh runs pinned OpenSpec strict validation, source/real-Engine tests, independent MCP distribution smoke and Linux installer fault/rollback fixtures. OpenSpec validates structure; regression/shared fixtures validate behavior.
- Linux x86_64 Docker bash scripts/verify-packaging.sh builds Gateway image, static musl Engine and OpenWrt Node bundle, checking versions, container health, repeat-bundle reproducibility, manifest digests and Node children with private libraries.
- Simulated systemctl verifies transactions, not real systemd/boot timing. Bundle tests do not emulate procd/router kernels/device libraries. Target installation, boot and actual recovery still need this checklist. macOS/OpenWrt installers do not have the Linux installer's transaction-rollback guarantee in this checklist's platform gate; Windows has no equivalent deployment gate.
