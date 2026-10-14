#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$script_dir/apply-release.py" engine "${1:?Request directory required}" "${2:?Release root required}"
