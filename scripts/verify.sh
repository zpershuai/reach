#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

python3 scripts/verify-toolchain.py

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

python3 scripts/install-publication-tools.py
for suite in toolchain public-source publication release-trust node-runtime node-launcher engine-linux-installer engine-macos-installer engine-openwrt-installer install-engine release-metadata package-notices release-assets release-plan release-download release-helpers; do
  python3 "scripts/test-$suite.py"
done
node --test scripts/test-grok-plugin.mjs scripts/test-engine-supervisor.mjs scripts/test-release-workflow.mjs
cargo fmt --all -- --check
cargo test --workspace --locked
cargo build --locked -p reach-rpc --bin engine
npm --prefix packages/gateway-console ci --ignore-scripts
npm --prefix packages/gateway-console test
npm --prefix packages/gateway-console run build
npm --prefix packages/reach-rpc test
npm --prefix packages/grok-bot-mcp-connector test
bash scripts/validate-round1.sh
bash scripts/validate-round1.sh fs.read.deadline.request.json

node scripts/validate-process-contract.mjs
node scripts/test-mcp-distribution.mjs
