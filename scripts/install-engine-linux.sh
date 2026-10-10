#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Linux || -f /etc/openwrt_release ]]; then
  echo 'This installer requires Linux with systemd. Use install-engine-openwrt.sh for OpenWrt.' >&2
  exit 1
fi
command -v python3 >/dev/null
command -v systemctl >/dev/null
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$script_dir/install-engine-linux.py" "$@"
