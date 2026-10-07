#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

python3 scripts/test-node-runtime.py
python3 scripts/test-node-launcher.py
node --test scripts/test-grok-plugin.mjs
cargo fmt --all -- --check
cargo test --workspace --locked
npm --prefix packages/reach-rpc test
npm --prefix packages/grok-bot-mcp-connector test
bash scripts/validate-round1.sh
bash scripts/validate-round1.sh fs.read.deadline.request.json

node scripts/validate-process-contract.mjs
node scripts/test-mcp-distribution.mjs
