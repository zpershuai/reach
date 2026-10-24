# Component versions and updates

English | [简体中文](versions_cn.md)

MCP, Engine and Gateway have independent SemVer releases. This guide's release baseline is Engine `0.3.2`, Gateway `0.7.2`, stdio MCP `0.4.0`. Fixes increment patch, compatible features minor, breaking changes major; update only changed components.

Gateway 0.7.2/Engine 0.3.2 strengthen open-source readiness with scoped client identities, policy-bound grants, safer setup tokens, redacted diagnostics and release/install verification/documentation. Stdio code stays 0.4.0 and wire protocol stays reach-rpc/1.0.

Gateway 0.7.0/Engine 0.3.0 introduce dynamic workspace JSON, validation/hot reload and same-session names/execution permissions/path-free generations. Gateway refreshes lists/console events and revokes relevant file/execute grants on removal/root replacement/execution disablement. processId control grants survive until expiry. MCP remains 0.4.0/protocol reach-rpc/1.0. Versions 0.7.1/0.3.1 only repair release gates, with the same features.

### Migrate to dynamic workspaces

1. Upgrade Gateway to 0.7.2 and verify existing Engine connectivity, then Engine to 0.3.2. Environment installations retain behavior without edits.
2. For dynamic changes, write existing roots/execution flags to device-local ~/.reach/workspaces.json using [Engine format](engine.md). Remove REACH_WORKSPACE_ROOTS/REACH_PROCESS_WORKSPACES, optionally set REACH_WORKSPACES_FILE and restart once. Keep real paths/credentials/reports privately.
3. Files poll every two seconds; Unix SIGHUP requests reload. Prefer atomic rename. Invalid edits retain last valid configuration without closing sessions.
4. To roll back, restore workspace env, remove REACH_WORKSPACES_FILE and restart. Old Engine ignores JSON.

Old Gateways refresh lists but cannot revoke old grants when replacing roots under the same name, leaving five minutes of authority. Use a new name until Gateway is upgraded.

Gateway 0.6.0 introduces HTTP MCP tools-list notifications: listChanged true, GET /mcp SSE notifications/tools/list_changed, compatible POST JSON. Refetch tools/list after notifications; refresh cached host metadata and verify in a new conversation.

Gateway 0.5.0/stdio MCP 0.4.0 add list_workspaces({deviceId}) from Engine ready metadata including processWorkspaces. Gateway also shares OAuth application's Engine ownership across repeated MCP initializations, supporting clients creating sessions per tool call. Rebuilt Engine 0.2.2 uses existing metadata with no workspace edits.

Gateway 0.4.0 introduces MCP OAuth registration, S256 PKCE, password/second-factor approval, rotating refresh and console revocation. Enable/setup console; Controller tokens/old Engines remain compatible. See [MCP configuration](mcp.md).

| Component | Version source of truth | Artifact version |
| --- | --- | --- |
| Engine | crates/reach-rpc/Cargo.toml [package].version | CARGO_PKG_VERSION compiled in |
| Gateway | packages/reach-rpc/package.json version | Generated dist/version.json |
| MCP | packages/grok-bot-mcp-connector/package.json version | Generated dist/version.json |

reach-rpc/1.0 and MCP 2025-03-26 are protocol formats, independent of component versions. Upgrades neither change protocols automatically nor require identical releases. Node runtime is separately pinned in scripts/node-runtime.json.

## Compatibility matrix and upgrade order

All components use reach-rpc/1.0; optional additions are ignored by older components. Gateway immediately closes other Engine protocols with closureReason unsupported_protocol and SESSION_PROTOCOL_UNSUPPORTED, without forwarding/retry.

| Combination | Status | Limits/result |
| --- | --- | --- |
| Gateway 0.7.x + Engine 0.3.x | Current supported | Dynamic workspaces, generation revocation, execution metadata |
| Gateway 0.7.x + Engine 0.2.x | Supported with reduction | File operations work; no generations, grants revoked only on removal, no JSON hot reload |
| Gateway 0.5–0.6 + Engine 0.3.x | Compatible, discouraged | File operations work; same-name root replacement leaves old grants up to five minutes. Upgrade Gateway first |
| Gateway < 0.5 | Untested/unsupported | Lacks workspace discovery/current authority model |
| Engine without process.* (non-Unix) | File only | PROCESS_UNSUPPORTED, not forwarded |
| Engine without workspace names | Unsupported | WORKSPACES_UNAVAILABLE; upgrade |
| Stdio Connector 0.4.x + Gateway ≥ 0.5 | Supported | Local tool lists are convenience; Gateway authorizes |
| Delegated/scoped OAuth | Current Gateway + REACH_DATA_DIR | Old Gateway rejects new schema; restore matching old snapshot, see [Client permissions](client-access.md) |

Back up Gateway data → upgrade Gateway/verify existing ready → upgrade Engines individually → update Connector as needed. Reverse order for rollback; Engine may independently return to 0.2.x, Gateway needs matching database snapshot. mcp.test.ts matrix and release-tag cross-version fixtures cover listed combinations; others are untested.

## Inspect actual artifact versions

These print versions without starting services or reading private service configuration:

```bash
"$HOME/.local/share/reach/engine" --version
"$HOME/.reach/runtime/node/bin/node" "$HOME/.local/share/reach/mcp/dist/main.js" --version
"$HOME/.reach/runtime/node/bin/node" packages/reach-rpc/dist/gateway-main.js --version
```

All accept -V. Installers inspect Engine version and write actual engineVersion/mcpVersion/nodeVersion to ~/.reach/versions.json, MCP null if absent. This inventory describes installed files; running processes need restart.

Public GET /healthz returns gatewayVersion. Controller-authenticated GET/POST /session/status returns gatewayVersion/engineVersion. Engine reports versions on heartbeat/ready without opening a special session.

MCP initialize returns serverInfo.version; all tool modes expose get_versions:

```json
{"deviceId":"engine-a"}
```

Example:

```json
{
  "mcpVersion": "0.4.0",
  "deviceId": "engine-a",
  "gatewayVersion": "0.7.2",
  "engineVersion": "0.3.2"
}
```

Query is read-only: no selection/open/close. Without deviceId use selected device; with none selected only local MCP is known and remote fields null. Old components missing version fields also yield null, never assumed equal to local. Network/auth failures are tool errors.

engineVersion is last reported, not current online proof. After Gateway restart it is null until heartbeat/ready; offline devices may retain historical values.

## Update release versions

For a changed Gateway/MCP package, for example:

```bash
npm --prefix packages/reach-rpc version 0.7.2 --no-git-tag-version
npm --prefix packages/grok-bot-mcp-connector version 0.4.0 --no-git-tag-version
```

Run only for changed components. npm updates Gateway lockfile. After Engine manifest edits run cargo check --workspace to refresh Cargo.lock.

Rebuild targets, run bash scripts/verify.sh and deploy using [Operations](operations.md). Gateway/MCP must ship all output including dist/version.json; manifest-only edits do not change existing JS versions. MCP installer copies version module/JSON.

Confirm via CLI/get_versions/status. GitHub updates below are optional alternatives to existing build/install flows.

## GitHub Releases

Source and binary distribution repositories may differ. Public binaries do not prove all source is public. Formal candidates must build an **approved anonymously readable public source revision**; release-manifest.json records full revision/source URL. Private-history mapping remains private. New workspace authorization/release gates have not necessarily shipped remotely; old version numbers do not prove those capabilities.

| Component | Required assets |
| --- | --- |
| Engine | engine-linux-x64-musl, engine-darwin-arm64, engine-darwin-x64, each with .NOTICES.txt/.licenses.tgz |
| Gateway | gateway-amd64.tgz; optional GHCR gateway-image.txt with full digest reference |
| Both | LICENSE, THIRD_PARTY_NOTICES.txt, third-party-licenses.tgz, release-manifest.json, SHA256SUMS |

Executable names remain compatible. Engine platform notices bind target/compiler/version/digest; public notices combine all three. Linux is static musl for systemd/OpenWrt x86_64; macOS uses arm64/Intel runners. Gateway tar contains outputs/npm manifests/Compose/Dockerfile/host helpers/licenses; image includes the same notices. Obtain first-install updater unit templates from matching public source; see [Operations](operations.md).

Workflow separates read-only build/verify/candidate from protected public-release publish. PR/forks receive no publishing credentials; manual dispatch verifies only. Publishing requires configured source repository, valid component tag on default branch, Linux/macOS verification, Linux packaging, every platform build, asset checks, source/asset/image-layer scans and approval of **these exact candidate bytes**. Cross-repo/optional GHCR tokens go only to publish. Read-only-check actual target repository/environment protection/token permissions; workflow text does not prove configuration.

Release notes use reviewed fixed content/public source links, never private commit text. Existing tag/Release blocks publishing without overwrite/deletion. Download verification covers every asset's digest/version/platform/notices/optional image digest; any timeout remains incomplete.

See [Release workflow](../dev/releases.md) for build/allow-list/permissions/verification commands. Trust is SHA-256 over approved HTTPS, without publisher signature/SBOM/provenance. Documentation edits never switch existing repository/service trust settings.

## Optional automatic updates

Default off. Enable only with REACH_UPDATE_ENABLED=1/true and REACH_UPDATE_REPO=zpershuai/reach. See [Configuration](configuration.md) and host-helper/rollback [Operations](operations.md). Paginated GitHub Releases selects highest stable component X.Y.Z, excluding draft/prerelease/equal/older. Default hourly checks back off updater only, preserving heartbeat/HTTP behavior.

Engine downloads on a background thread from approved HTTPS, verifies unique digest/platform/architecture before --version, and replaces only without connecting/active/draining sessions. It saves engine.prev/private health intent. New installer guard waits for the restarted process's first successful heartbeat; exit/30-second timeout restores binary/inventory. Old launchers lacking guard cannot apply host updates: upgrade installer in maintenance first. Existing versions.json tracks engineVersion.

Compose Engine/Gateway write idle request.json to shared directories. Host helpers prepare/verify images, handshake for idle, pause new sessions and recreate. Gateway requires every registered Engine session none. Without helper requests/logs remain and the current process continues.

Updates replace neither private Node nor MCP Connector. Failure preserves current artifacts; success is a fresh process without old memory sessions/grants/deduplication. Clients reopen.
