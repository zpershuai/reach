#!/bin/sh
set -eu

repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
exec sh "$repo_root/scripts/run-node.sh" "$repo_root/packages/reach-rpc/dist/gateway-main.js" "$@"
