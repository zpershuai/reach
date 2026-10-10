#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if [[ -x "$repo_root/node_modules/.bin/openspec" ]]; then
  openspec_cli="$repo_root/node_modules/.bin/openspec"
else
  openspec_cli=openspec
fi
required_openspec="$(node -p 'require("./package.json").devDependencies["@fission-ai/openspec"]')"
[[ "$("$openspec_cli" --version)" == "$required_openspec" ]] || {
  echo "Install pinned verification tools with npm ci --ignore-scripts." >&2
  exit 1
}
"$openspec_cli" validate --all --strict --no-interactive

python3 scripts/test-node-runtime.py
python3 scripts/test-node-launcher.py
python3 scripts/test-engine-linux-installer.py
node --test scripts/test-grok-plugin.mjs
cargo fmt --all -- --check
cargo test --workspace --locked
npm --prefix packages/reach-rpc test
npm --prefix packages/grok-bot-mcp-connector test
bash scripts/validate-round1.sh
bash scripts/validate-round1.sh fs.read.deadline.request.json

node scripts/validate-process-contract.mjs
node scripts/test-mcp-distribution.mjs
