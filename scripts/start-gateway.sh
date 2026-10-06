#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec bash "$repo_root/scripts/run-node.sh" "$repo_root/packages/reach-rpc/dist/gateway-main.js" "$@"
