# Operations, upgrades and rollback

English | [简体中文](operations_cn.md)

Dependency order is Caddy/Docker → Gateway → Engine → MCP client. Gateway upgrades interrupt every active Engine session. Ask clients to close and resolve uncertain writes before changing services.

## Routine status checks

```bash
ssh deploy@gateway.example.com 'cd /srv/reach/deploy && docker compose ps'
ssh deploy@gateway.example.com 'cd /srv/reach/deploy && docker compose logs --tail 60 gateway'
ssh deploy@gateway.example.com 'systemctl is-active caddy docker'
curl --fail --silent --show-error https://reach.example.com/healthz
launchctl print "gui/$(id -u)/org.reach.engine"
tail -n 40 "$HOME/.local/share/reach/engine-error.log"
```

Compose rotates container logs; Mac Engine logs have no automatic rotation. To archive Mac logs, bootout first, archive, then bootstrap, avoiding concurrent writers. For disk pressure also inspect workspaces and VPS Docker images.

## What to back up

| Content | Purpose |
| --- | --- |
| Engine workspaces | Business files; back up regularly |
| Both env files and MCP devices JSON | Matching credentials/device mappings |
| Gateway JS, lockfile, Compose/Dockerfile, image | Restore a chosen version |
| Engine binary and MCP JS/package.json | Restore device/client versions |
| Caddyfile and release record | Restore routing and identify artifacts |

Private credential backups need directories 700/files 600. Files cannot restore Gateway memory sessions/grants/deduplication. Preserve MCP client configuration without public device tokens.

## Gateway upgrade

### 1. Save the previous VPS version

Run in one VPS shell, adapting example `/srv/reach`:

```bash
release_stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_dir="/srv/reach-backups/$release_stamp"
umask 077
mkdir -p "$backup_dir"
docker image tag reach-gateway:current "reach-gateway:backup-$release_stamp"
tar -czf "$backup_dir/gateway.tgz" -C /srv/reach \
  deploy/compose.yaml deploy/Dockerfile.gateway deploy/gateway.env deploy/engines.json \
  packages/reach-rpc/package.json packages/reach-rpc/package-lock.json \
  packages/reach-rpc/dist
cp /etc/caddy/Caddyfile "$backup_dir/Caddyfile"
```

Record release_stamp and retain backup image tags through rollback window; do not prune them. Gateway-only upgrades need no Caddy change.

### 2. Build locally, upload and recreate

Recompile/package/upload using [Gateway deployment](gateway.md). Do not overwrite remote gateway.env without credential changes.

```bash
ssh deploy@gateway.example.com 'cd /srv/reach/deploy && docker compose up -d --build gateway'
```

Keep release path, Compose project name and ports. Replacement ends old sessions; clients select/open again. Check health, then [public RPC/MCP](verification.md).

### 3. Roll back the previous version on this architecture

Choose the actual backup timestamp on VPS; replace the placeholder:

```bash
release_stamp=YYYYMMDDTHHMMSSZ
tar -xzf "/srv/reach-backups/$release_stamp/gateway.tgz" -C /srv/reach
docker image tag "reach-gateway:backup-$release_stamp" reach-gateway:current
cd /srv/reach/deploy
docker compose up -d --no-build --force-recreate gateway
```

Omit `--build` to use the retained image. If credentials changed, restore matching Engine/MCP configuration too; restoring only Gateway causes authentication failure. End maintenance after health and file read pass.

## Engine and MCP upgrades

Back up current Mac binary/configuration in one shell:

```bash
release_stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_dir="$HOME/.local/share/reach-backups/$release_stamp"
umask 077
mkdir -p "$backup_dir"
cp "$HOME/.local/share/reach/engine" "$backup_dir/engine"
cp "$HOME/.config/reach/engine.env" "$backup_dir/engine.env"
```

For MCP also back up `~/.local/share/reach/mcp/`, `~/.config/reach/mcp-devices.json`, `mcp.json`. Stop the client Connector to avoid mixed module versions.

Rebuild from repository root and stage installed configuration:

```bash
cargo build --release --locked --bin engine
npm --prefix packages/grok-bot-mcp-connector run build
mkdir -p .reach
chmod 700 .reach
install -m 600 "$HOME/.config/reach/engine.env" .reach/engine-upgrade.env
install -m 600 "$HOME/.config/reach/mcp-devices.json" .reach/devices-upgrade.json
bash scripts/install-engine-macos.sh .reach/engine-upgrade.env .reach/devices-upgrade.json
```

This assumes both components installed. For Engine-only updates omit npm build, devices staging and the second installer argument. Initial compilation still needs reach-rpc npm compiler dependencies. The installer updates MCP entry/runtime paths while preserving static mode/timeouts/other env options. Engine-only upgrades also switch installed MCP launch settings to the independent runtime.

For Engine rollback, bootout, restore private binary backup (755) and engine.env (600), then bootstrap the original plist. For MCP stop the child, restore its entire runtime directory/devices JSON and reload. Binary rollback does not roll back workspace files.

## Configuration changes and credential rotation

After Gateway env edits use `docker compose up -d gateway`; restart alone does not read new env. Restart Engine's platform service after env edits. After registry changes use `docker compose up -d --force-recreate gateway` to remount/reload. Restart Connector after device/env changes.

1. Save current private configuration, close Controller sessions, stop Engine and related MCP children.
2. Generate distinct new Controller/Engine tokens securely in private files.
3. Update VPS gateway.env, device engine.env, extra registry, every client device JSON and verification `.reach/deployment.json`. Credential files remain 600. Registry must be container-node readable, with admin-only parent access.
4. Recreate Gateway configuration, start Engine/client and verify authentication/real files.

Shared Owner-token clients all need updating. Everyday delegated clients rotate/revoke independently; see [Client permissions](client-access.md). Do not overwrite active configuration by rerunning first-generation examples.

## Disable components

- Gateway: `docker compose stop gateway`; restore with `docker compose up -d gateway`. Manually stopped services stay stopped.
- Engine: on Mac unload/move out the matching plist; Linux `systemctl disable --now reach-engine.service` (add `--user` for user service); OpenWrt `/etc/init.d/reach-engine stop` and disable. Preserve workspaces/private config.
- MCP: remove reach from client configuration and stop its child; removing the entry does not stop Engine.

Stopping Engine never removes workspaces. Before full uninstall, back up business files and separately remove known program/config files; never delete all of `~/.reach` blindly.

## Install the optional GitHub Release updater

See [Versions](versions.md) and [Configuration](configuration.md). Paths are replaceable examples; keep actual paths in private records.

Gateway remains read-only/non-root with cap_drop ALL and no Docker socket mount. A host Python 3 helper downloads/verifies/applies through Docker/Compose permissions. A systemd path unit watches the shared directory without a socket sidecar.

Check out source matching the target release and prepare helper/systemd templates. These uploads also support hosts installed from Release tarballs, which lack unit templates. Full [manual Gateway packages](gateway.md) can reuse the same preparation.

Run from local repository root with your SSH target:

```bash
tar -czf /tmp/reach-updater-install.tgz \
  scripts/apply-gateway-release.sh scripts/apply-engine-release.sh scripts/apply-release.py \
  scripts/release_trust.py scripts/binary_identity.py \
  deploy/reach-gateway-update.service deploy/reach-gateway-update.path
scp /tmp/reach-updater-install.tgz deploy@gateway.example.com:/tmp/reach-updater-install.tgz
```

Then on Linux host, point release_root to the existing root containing deploy/compose.yaml. Example uses template default `/opt/reach`; preserve env/registry:

```bash
release_root=/opt/reach
updater_source="$(mktemp -d)"
tar -xzf /tmp/reach-updater-install.tgz -C "$updater_source"
sudo install -d -m 755 "$release_root/scripts"
sudo install -m 755 "$updater_source/scripts/apply-gateway-release.sh" "$release_root/scripts/apply-gateway-release.sh"
sudo install -m 755 "$updater_source/scripts/apply-engine-release.sh" "$release_root/scripts/apply-engine-release.sh"
sudo install -m 644 "$updater_source/scripts/apply-release.py" "$release_root/scripts/apply-release.py"
sudo install -m 644 "$updater_source/scripts/release_trust.py" "$release_root/scripts/release_trust.py"
sudo install -m 644 "$updater_source/scripts/binary_identity.py" "$release_root/scripts/binary_identity.py"
sudo install -d -m 750 -o 1000 -g 1000 "$release_root/deploy/update"
sudo install -m 644 "$updater_source/deploy/reach-gateway-update.service" /etc/systemd/system/reach-gateway-update.service
sudo install -m 644 "$updater_source/deploy/reach-gateway-update.path" /etc/systemd/system/reach-gateway-update.path
sudo install -d -m 700 /etc/reach
if [[ ! -e /etc/reach/updater.env ]]; then
  sudo install -m 600 /dev/null /etc/reach/updater.env
fi
rm -r "$updater_source"
```

For other roots, update the installed service helper/request/root paths and path unit PathExists together. Never overwrite existing updater.env; the empty-file initialization is first-install only. Optional REACH_UPDATE_GITHUB_TOKEN_FILE points to a host mode-600 token file. Private Release downloads use GitHub API and never forward tokens to redirected asset storage.

After configuring gateway.env update policy:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now reach-gateway-update.path
cd "$release_root/deploy"
docker compose up -d gateway
```

Before enabling, every Engine `/session/status` must be none. Helper prefers versioned GHCR images, verifying published digest and Gateway --version. Otherwise it verifies tarball digest, builds and verifies version. Only after preparation does it write apply.json. Components retain sessions until natural idle, then acknowledge nonce-matching idle.json while pausing new REST/MCP sessions/Engine leases. Only then does helper tag/recreate. It waits five minutes; success/failure deletes handshake files, and helper crashes expire after at most 15 minutes.

After recreation check actual container image ID, running/health and Gateway /healthz; Engine checks a successful heartbeat from the current container. Failure restores/rechecks previous image; tar fallback restores old host payload too. Failed rollback reports UPDATE_ROLLBACK_FAILED and retains request/previous tags. Preserve reach-gateway:previous, current env/registry/Compose environment/mount policy. Use generated private `.reach/gateway-update.override.json` for future Compose commands. Only healthy startup writes result.json/removes request.json. Failures retain requests for retry; inspect journalctl -u reach-gateway-update.service. No helper means no container recreation.

Compose Engine needs a separate shared directory, never sharing request.json with Gateway/other Engines. Copy units under unique names, invoking apply-engine-release.sh REQUEST_DIR RELEASE_ROOT; configure REACH_UPDATE_COMPOSE_FILE, service and binary paths in separate private helper env. Helper builds from the existing Engine image with new static musl binary, performs idle handshake and recreates using an image-only override, retaining env, command, network and workspace mounts. Private Node remains. Reuse `.reach/engine-update.override.json` in later Compose operations to avoid old images.

Host Engine needs no Docker helper, but install the candidate launcher first to run engine-supervisor.mjs with private Node. Guard sets internal health env; direct Engine execution diagnoses HOST_UPDATE_REQUIRES_GUARDED_LAUNCHER instead of applying updates. At idle updater prepares health intent, saves engine.prev, atomically replaces and exits. Restarted guard waits at most 30 seconds for a fresh-process successful heartbeat with separate nonce; stale heartbeat files cannot confirm. Exit/timeout restores old binary/inventory and restarts. Failed recovery retains private intent/backup/recovery markers and reports HOST_UPDATE_RECOVERY_REQUIRED without success. Updates never execve to restore sessions; clients reopen leases after either component restarts.

### Rollback after automatic updates

Disable updates in private env and restart first to prevent immediate reupgrade. Disable Gateway path with `sudo systemctl disable --now reach-gateway-update.path`.

Stop Host Engine's service, copy engine.prev over engine (755), then restart the original service. Installer private backups are also valid. Node/workspaces do not roll back.

Gateway rollback:

```bash
docker tag reach-gateway:previous reach-gateway:current
cd /opt/reach
docker compose -f deploy/compose.yaml -f .reach/gateway-update.override.json up -d --no-build --force-recreate gateway
```

For Docker Engine, tag reach-engine:previous as reach-engine:current and use original Compose plus `.reach/engine-update.override.json` for up -d --no-build --force-recreate engine. Helpers try previous-image recovery on recreation failure. Even after successful recreation run [business verification](verification.md).

## Download and digest trust boundaries

Installers/updaters/helpers accept certificate-verified approved HTTPS origins only: GitHub API, github.com, release-assets.githubusercontent.com and objects.githubusercontent.com; Node uses nodejs.org. Recheck each redirect and strip Authorization/Cookie across origins without reattaching later. file/plain HTTP are not production sources. Explicit fixture test mode must never enter deployment configuration.

Verify component/platform asset uniqueness and a unique SHA256SUMS from protected release channels, then ELF/Mach-O architecture or Docker OS/architecture/component, before running --version. Version probing does not activate services. Bad format/architecture/digest/version cannot install/replace artifacts; verification failure leaves old services running.

Digests establish byte equality with the obtained manifest, still trusting HTTPS, repository write access and release protection. An attacker replacing both bypasses this check. This work adds no publisher signatures, SBOM or provenance attestation; SHA-256 is not a signature.

## Manual recovery after platform installation failure

Stop the affected test/maintenance service and disable updates. Preserve config, workspaces and evidence; never delete all ~/.reach. Restore original running/enabled state, then independently [verify RPC/MCP](verification.md): survival/one heartbeat is not business acceptance.

| Platform | Recovery records/actions |
| --- | --- |
| Linux systemd | Private ~/.reach/backups/linux-*/recovery.json maps target/backup; service-state.json records active and enabled/disabled/enabled-runtime. Stop, restore files/runtime symlink, daemon-reload and restore original states only |
| macOS launchd | Private ~/.reach/backups/macos-*/recovery.json records files, label, loaded/disabled. Bootout original label, restore mappings/disabled state, bootstrap original plist only if previously loaded; never create a second label |
| OpenWrt procd | Private /root/.reach/backups/openwrt-*/targets with numbered files/.link and service-state active/enabled. Stop/disable, restore targets/symlinks, remove originally absent targets, restore only original enable/start |
| Host auto-update | Stop supervisor, verify previousDigest against engine.prev, restore old Engine/inventory, then resolve engine.update-pending.json, engine.update-health.json, engine.update-recovery.json. Never delete markers to force an unverified candidate |
| Compose helper | Preserve previous image, private request/override and incomplete payload recovery. Retag previous, use original Compose/private override, verify health/data mounts before unpausing |

From repository root, Linux/macOS file recovery may use the same atomic helper. Select a verified private backup_dir, keep the service stopped, and never execute/publish untrusted recovery.json:

```bash
backup_dir="$HOME/.reach/backups/linux-REPLACE_WITH_SELECTED_ID"
python3 - "$backup_dir/recovery.json" <<'RESTORE_FILES'
import json
from pathlib import Path
import sys
sys.path.insert(0, 'scripts')
from install_transaction import restore_file
record = json.loads(Path(sys.argv[1]).read_text())
for entry in reversed(record['files']):
    restore_file(Path(entry['target']), Path(entry['backup']) if entry['backup'] else None)
print('Files restored; supervisor remains stopped for verification.')
RESTORE_FILES
```

Restore service state from that backup. Linux user services use systemctl --user daemon-reload and original name; enabled-runtime needs enable --runtime rather than permanent enable. Mac uses the same saved label/plist. Restore OpenWrt numbered targets only in a private maintenance terminal, rebuilding symlinks from .link; normal rollback uses the same sequence.

Fault fixtures cover files/runtime restoration, disabled/stopped services, initial cleanup, startup failure and retained rollback-failure records. Real launchd/procd/systemd, host Docker and power-loss acceptance are recorded separately; simulated supervisors do not prove target-device success.
