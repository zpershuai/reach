#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The helper copies only release payloads; existing deploy/data/, env and registry stay in place.
exec python3 "$script_dir/apply-release.py" gateway "${1:?Request directory required}" "${2:?Release root required}"
