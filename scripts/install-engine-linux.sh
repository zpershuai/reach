#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Linux || -f /etc/openwrt_release ]]; then
  echo 'This installer requires Linux with systemd. Use install-engine-openwrt.sh for OpenWrt.' >&2
  exit 1
fi
command -v python3 >/dev/null
command -v systemctl >/dev/null
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
engine_source="${1:?Usage: install-engine-linux.sh ENGINE_BINARY ENGINE_ENV [NODE_ARCHIVE]}"
config_source="${2:?Engine configuration file required}"
[[ -f "$config_source" ]]
engine_version="$("$engine_source" --version)"
service_command=(systemctl)
unit_dir=/etc/systemd/system
if [[ "$(id -u)" != 0 ]]; then
  service_command+=(--user)
  unit_dir="$HOME/.config/systemd/user"
  "${service_command[@]}" show-environment >/dev/null
fi

engine_dir="$HOME/.local/share/reach"
config_dir="$HOME/.config/reach"
reach_dir="$HOME/.reach"
mkdir -p "$engine_dir" "$config_dir" "$reach_dir/workspace" "$unit_dir"
chmod 700 "$engine_dir" "$config_dir" "$reach_dir" "$reach_dir/workspace"
backup="$reach_dir/backups/$(date -u +%Y%m%dT%H%M%SZ)-linux"
mkdir -p "$backup"
chmod 700 "$backup"
for installed in "$engine_dir/engine" "$engine_dir/start-engine.sh" "$config_dir/engine.env" "$reach_dir/versions.json" "$unit_dir/reach-engine.service"; do
  if [[ -f "$installed" ]]; then cp -p "$installed" "$backup/$(basename "$installed")"; fi
done
if [[ -L "$reach_dir/runtime/node" ]]; then
  readlink "$reach_dir/runtime/node" > "$backup/node-runtime-link"
fi
runtime_args=()
if [[ -n "${3:-}" ]]; then runtime_args+=(--archive "$3"); fi
node_bin="$(python3 "$script_dir/install-node-runtime.py" "${runtime_args[@]}")"

if "${service_command[@]}" is-active --quiet reach-engine.service; then
  "${service_command[@]}" stop reach-engine.service
fi
install -m 755 "$engine_source" "$engine_dir/engine.new"
mv -f "$engine_dir/engine.new" "$engine_dir/engine"
install -m 600 "$config_source" "$config_dir/engine.env.new"
mv -f "$config_dir/engine.env.new" "$config_dir/engine.env"
install -m 755 "$script_dir/run-node.sh" "$engine_dir/run-node.sh"
cat > "$engine_dir/start-engine.sh" <<'START_ENGINE'
#!/usr/bin/env bash
set -euo pipefail
set -a
source "$HOME/.config/reach/engine.env"
set +a
export REACH_NODE_BIN="$HOME/.reach/runtime/node/bin/node"
export PATH="$(dirname "$REACH_NODE_BIN"):$PATH"
exec "$HOME/.local/share/reach/engine"
START_ENGINE
chmod 700 "$engine_dir/start-engine.sh"

python3 - "$engine_dir" "$reach_dir" "$unit_dir" "$node_bin" "$engine_version" <<'INSTALL_METADATA'
import json
import os
from pathlib import Path
import subprocess
import sys

directory, reach, units = map(Path, sys.argv[1:4])
node, engine_version = sys.argv[4:]
versions_file = reach / 'versions.json'
versions = json.loads(versions_file.read_text()) if versions_file.exists() else {}
versions.update(engineVersion=engine_version, nodeVersion=subprocess.check_output([node, '--version'], text=True).strip())
mcp_version = directory / 'mcp/dist/version.json'
if not mcp_version.exists():
    mcp_version = directory / 'mcp/package.json'
if mcp_version.exists():
    versions['mcpVersion'] = json.loads(mcp_version.read_text())['version']
else:
    versions.setdefault('mcpVersion', None)
temporary = reach / 'versions.json.new'
temporary.write_text(json.dumps(versions, indent=2) + '\n')
temporary.chmod(0o600)
temporary.replace(versions_file)

def unit_string(value):
    return json.dumps(str(value).replace('%', '%%'))

system = os.geteuid() == 0
unit = '[Unit]\nDescription=Reach Engine\n'
if system:
    unit += 'Wants=network-online.target\nAfter=network-online.target\n'
unit += ('\n[Service]\nType=simple\n'
         f'Environment={unit_string("HOME=" + str(Path.home()))}\n'
         f'ExecStart=/bin/bash {unit_string(directory / "start-engine.sh")}\n'
         'Restart=always\nRestartSec=5\nTimeoutStopSec=15\nUMask=0077\n'
         '\n[Install]\nWantedBy=' + ('multi-user.target' if system else 'default.target') + '\n')
target = units / 'reach-engine.service'
target.write_text(unit)
target.chmod(0o644)
print(json.dumps(versions))
INSTALL_METADATA

"${service_command[@]}" daemon-reload
"${service_command[@]}" enable reach-engine.service
"${service_command[@]}" restart reach-engine.service
"${service_command[@]}" is-active --quiet reach-engine.service
echo "Installed Reach Engine $engine_version with private Node runtime (systemd)."
