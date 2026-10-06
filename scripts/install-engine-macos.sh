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
agent_file="$HOME/Library/LaunchAgents/top.zpershuai.reach-engine.plist"
mkdir -p "$engine_dir" "$config_dir" "$HOME/Library/LaunchAgents"
chmod 700 "$engine_dir" "$config_dir"
install -m 755 "$repo_root/target/release/engine" "$engine_dir/engine"
install -m 600 "$engine_config" "$config_dir/engine.env"
if [[ -n "${2:-}" ]]; then
  install -m 600 "$2" "$config_dir/mcp-devices.json"
  mkdir -p "$engine_dir/mcp/dist"
  install -m 644 "$repo_root/packages/grok-bot-mcp-connector/package.json" "$engine_dir/mcp/package.json"
  for module in main config gateway server tools; do
    install -m 644 "$repo_root/packages/grok-bot-mcp-connector/dist/$module.js" "$engine_dir/mcp/dist/$module.js"
  done
  python3 - "$engine_dir" "$config_dir" "$(command -v node)" <<'MCP_CONFIG'
import json
import sys
from pathlib import Path

directory, config, node = sys.argv[1:]
target = Path(config) / 'mcp.json'
target.write_text(json.dumps({'mcpServers': {'reach': {
    'command': node,
    'args': [directory + '/mcp/dist/main.js'],
    'env': {'REACH_MCP_DEVICES_FILE': config + '/mcp-devices.json', 'REACH_MCP_READY_POLL_MS': '1000'},
}}}, indent=2))
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
python3 - "$engine_dir" "$agent_file" <<'PLIST'
import plistlib
import sys
from pathlib import Path

directory, target = sys.argv[1:]
with Path(target).open('wb') as output:
    plistlib.dump({
        'Label': 'top.zpershuai.reach-engine',
        'ProgramArguments': [directory + '/start-engine.sh'],
        'RunAtLoad': True,
        'KeepAlive': True,
        'ThrottleInterval': 10,
        'StandardOutPath': directory + '/engine.log',
        'StandardErrorPath': directory + '/engine-error.log',
    }, output)
PLIST
launchctl bootout "gui/$(id -u)/top.zpershuai.reach-engine" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$agent_file"
launchctl print "gui/$(id -u)/top.zpershuai.reach-engine" | sed -n '1,20p'
