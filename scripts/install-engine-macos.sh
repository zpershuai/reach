#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Darwin ]]; then
  echo 'This installer requires macOS.' >&2
  exit 1
fi
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
engine_config="${1:?Usage: install-engine-macos.sh /path/to/engine.env}"
engine_dir="$HOME/.local/share/reach"
config_dir="$HOME/.config/reach"
agent_label="$(python3 - "$engine_dir" <<'AGENT_LABEL'
import os
from pathlib import Path
import plistlib
import re
import sys

wrapper = str(Path(sys.argv[1]) / 'start-engine.sh')
existing = set()
for path in (Path.home() / 'Library/LaunchAgents').glob('*.plist'):
    try:
        document = plistlib.loads(path.read_bytes())
    except (OSError, plistlib.InvalidFileException, ValueError):
        continue
    if document.get('ProgramArguments') == [wrapper]:
        existing.add(document['Label'])
if len(existing) > 1:
    raise SystemExit('Multiple Reach LaunchAgents found; resolve the duplicate services before installing.')
label = os.environ.get('REACH_LAUNCHD_LABEL') or next(iter(existing), 'org.reach.engine')
if existing and label not in existing:
    raise SystemExit('An existing Reach LaunchAgent uses a different label; reuse that label when upgrading.')
if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', label):
    raise SystemExit('REACH_LAUNCHD_LABEL contains invalid characters.')
print(label)
AGENT_LABEL
)"
agent_file="$HOME/Library/LaunchAgents/$agent_label.plist"
engine_binary="${REACH_ENGINE_BINARY:-$repo_root/target/release/engine}"
engine_version="$("$engine_binary" --version)"
node_bin="$(python3 "$repo_root/scripts/install-node-runtime.py")"
mkdir -p "$engine_dir" "$config_dir" "$HOME/Library/LaunchAgents"
chmod 700 "$engine_dir" "$config_dir"
install -m 755 "$repo_root/scripts/run-node.sh" "$engine_dir/run-node.sh"
install -m 755 "$engine_binary" "$engine_dir/engine"
install -m 600 "$engine_config" "$config_dir/engine.env"
if [[ -n "${2:-}" ]]; then
  install -m 600 "$2" "$config_dir/mcp-devices.json"
  mkdir -p "$engine_dir/mcp/dist"
  install -m 644 "$repo_root/packages/grok-bot-mcp-connector/package.json" "$engine_dir/mcp/package.json"
  for module in main config gateway server tools protocol invoker result version; do
    install -m 644 "$repo_root/packages/grok-bot-mcp-connector/dist/$module.js" "$engine_dir/mcp/dist/$module.js"
  done
  install -m 644 "$repo_root/packages/grok-bot-mcp-connector/dist/version.json" "$engine_dir/mcp/dist/version.json"
fi
if [[ -f "$engine_dir/mcp/dist/main.js" && -f "$config_dir/mcp-devices.json" ]]; then
  python3 - "$engine_dir" "$config_dir" "$node_bin" <<'MCP_CONFIG'
import json
import sys
from pathlib import Path

directory, config, node = sys.argv[1:]
target = Path(config) / 'mcp.json'
document = json.loads(target.read_text()) if target.exists() else {}
server = document.setdefault('mcpServers', {}).setdefault('reach', {})
server.update(command=node, args=[directory + '/mcp/dist/main.js'])
environment = server.setdefault('env', {})
environment.update(REACH_MCP_DEVICES_FILE=config + '/mcp-devices.json')
environment.pop('REACH_NODE_BIN', None)
environment.setdefault('REACH_MCP_READY_POLL_MS', '1000')
target.write_text(json.dumps(document, indent=2) + '\n')
target.chmod(0o600)
MCP_CONFIG
fi
cat > "$engine_dir/start-engine.sh" <<'ENGINE_START'
#!/bin/bash
set -euo pipefail
set -a
source "$HOME/.config/reach/engine.env"
set +a
exec "$HOME/.local/share/reach/engine"
ENGINE_START
chmod 700 "$engine_dir/start-engine.sh"
python3 - "$engine_dir" "$agent_file" "$agent_label" <<'PLIST'
import plistlib
import sys
from pathlib import Path

directory, target, label = sys.argv[1:]
with Path(target).open('wb') as output:
    plistlib.dump({
        'Label': label,
        'ProgramArguments': [directory + '/start-engine.sh'],
        'RunAtLoad': True,
        'KeepAlive': True,
        'ThrottleInterval': 10,
        'StandardOutPath': directory + '/engine.log',
        'StandardErrorPath': directory + '/engine-error.log',
    }, output)
PLIST
python3 - "$engine_dir" "$HOME/.reach" "$node_bin" "$engine_version" <<'VERSIONS'
import json
import subprocess
import sys
from pathlib import Path

directory, reach, node, engine_version = sys.argv[1:]
mcp_package = Path(directory) / 'mcp/package.json'
mcp_build = Path(directory) / 'mcp/dist/version.json'
mcp_version = None
if mcp_package.exists():
    mcp_manifest = mcp_build if mcp_build.exists() else mcp_package
    mcp_version = json.loads(mcp_manifest.read_text())['version']
versions = {
    'engineVersion': engine_version,
    'mcpVersion': mcp_version,
    'nodeVersion': subprocess.check_output([node, '--version'], text=True).strip(),
}
target = Path(reach) / 'versions.json'
temporary = target.with_suffix('.json.tmp')
temporary.write_text(json.dumps(versions, indent=2) + '\n')
temporary.chmod(0o600)
temporary.replace(target)
print(json.dumps(versions))
VERSIONS
launchctl bootout "gui/$(id -u)/$agent_label" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$agent_file"
launchctl print "gui/$(id -u)/$agent_label" | sed -n '1,20p'
