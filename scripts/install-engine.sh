#!/usr/bin/env bash
# Install a released Engine binary: download it, verify it against the Release
# SHA256SUMS and its --version, then hand it to the platform service installer.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
engine_config="${1:?Usage: install-engine.sh /path/to/engine.env [mcp-devices.json]}"
[[ -f "$engine_config" ]] || { echo "Engine config not found: $engine_config" >&2; exit 1; }
repo="${REACH_RELEASE_REPO:-zpershuai/reach}"

if [[ -f /etc/openwrt_release ]]; then
  echo 'OpenWrt needs a Node bundle; follow docs/deploy/openwrt.md instead.' >&2
  exit 1
fi
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64) asset=engine-linux-x64-musl ;;
  Darwin/arm64) asset=engine-darwin-arm64 ;;
  Darwin/x86_64) asset=engine-darwin-x64 ;;
  *)
    echo "No prebuilt Engine for $(uname -s)/$(uname -m); build from source (docs/deploy/engine.md)." >&2
    exit 1
    ;;
esac

version="${REACH_ENGINE_VERSION:-}"
if [[ -z "$version" ]]; then
  api="${REACH_RELEASE_API_URL:-https://api.github.com/repos/$repo/releases?per_page=100}"
  version="$(python3 "$script_dir/release-download.py" "$api" | python3 -c '
import json, sys
for release in json.load(sys.stdin):
    tag = release.get("tag_name", "")
    if tag.startswith("engine-v") and not release.get("draft") and not release.get("prerelease"):
        print(tag)
        break
')"
  [[ -n "$version" ]] || { echo "No published engine-v* Release found in $repo." >&2; exit 1; }
fi
version="${version#engine-v}"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid Engine version" >&2
  exit 1
fi

base="${REACH_RELEASE_BASE_URL:-https://github.com/$repo/releases/download}/engine-v$version"
work="$(mktemp -d "${TMPDIR:-/tmp}/reach-engine-install.XXXXXX")"
trap 'rm -rf "$work"' EXIT
python3 "$script_dir/release-download.py" "$base/$asset" "$work/engine"
python3 "$script_dir/release-download.py" "$base/SHA256SUMS" "$work/SHA256SUMS"

expected="$(python3 - "$work/SHA256SUMS" "$asset" <<'CHECKSUM'
from pathlib import Path
import re
import sys
rows = [line.split() for line in Path(sys.argv[1]).read_text().splitlines()]
selected = [row for row in rows if len(row) >= 2 and row[1].lstrip('*') == sys.argv[2]]
if len(selected) == 1 and len(selected[0]) == 2 and re.fullmatch('[a-fA-F0-9]{64}', selected[0][0]):
    print(selected[0][0].lower())
CHECKSUM
)"
if [[ ! "$expected" =~ ^[0-9a-f]{64}$ ]]; then
  echo "SHA256SUMS has no single valid digest for $asset." >&2
  exit 1
fi
if command -v sha256sum >/dev/null; then
  actual="$(sha256sum "$work/engine" | awk '{ print $1 }')"
else
  actual="$(shasum -a 256 "$work/engine" | awk '{ print $1 }')"
fi
if [[ "$actual" != "$expected" ]]; then
  echo "Checksum mismatch for $asset; refusing to install." >&2
  exit 1
fi
python3 "$script_dir/binary_identity.py" "$work/engine"
chmod 755 "$work/engine"
reported="$("$work/engine" --version 2>/dev/null)" || { echo "ENGINE_VERSION_CHECK_FAILED" >&2; exit 1; }
if [[ "$reported" != "$version" ]]; then
  echo "ENGINE_VERSION_MISMATCH: expected $version; refusing to install." >&2
  exit 1
fi
echo "Verified $asset $version."

if [[ "${REACH_INSTALL_DRY_RUN:-}" == 1 ]]; then
  exit 0
fi
if [[ "$(uname -s)" == Darwin ]]; then
  REACH_ENGINE_BINARY="$work/engine" bash "$script_dir/install-engine-macos.sh" "$@"
else
  [[ $# -eq 1 ]] || { echo 'The Linux installer takes only the Engine config.' >&2; exit 1; }
  bash "$script_dir/install-engine-linux.sh" "$work/engine" "$engine_config"
fi
