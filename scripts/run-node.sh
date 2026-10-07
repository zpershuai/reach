#!/bin/sh
set -eu

export REACH_NODE_BIN="${REACH_NODE_BIN:-$HOME/.reach/runtime/node/bin/node}"
if [ ! -x "$REACH_NODE_BIN" ]; then
  echo 'Reach Node runtime is missing. Install the Engine or run python3 scripts/install-node-runtime.py first.' >&2
  exit 1
fi
export PATH="$(dirname "$REACH_NODE_BIN"):$PATH"
exec "$REACH_NODE_BIN" "$@"
