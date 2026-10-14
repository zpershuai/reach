#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output="${1:-$repo_root/.reach/release}"
image="${2:-reach-gateway:verification}"
mkdir -p "$output"
output="$(cd "$output" && pwd)"
cd "$repo_root"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
npm --prefix packages/reach-rpc run build
version="$(node -p 'require("./packages/reach-rpc/package.json").version')"
docker build --platform linux/amd64 -f deploy/Dockerfile.gateway -t "$image" .
[[ "$(docker run --rm --platform linux/amd64 "$image" node dist/gateway-main.js --version)" == "$version" ]]
# Include manifests for a self-contained rebuild and helper installation.
mkdir -p "$work/packages/reach-rpc" "$work/deploy" "$work/scripts"
cp -R packages/reach-rpc/dist "$work/packages/reach-rpc/"
cp packages/reach-rpc/package{,-lock}.json "$work/packages/reach-rpc/"
cp deploy/compose.yaml deploy/Dockerfile.gateway "$work/deploy/"
for helper in scripts/apply-*-release.sh scripts/apply-release.py; do
  if [[ -f "$helper" ]]; then cp "$helper" "$work/scripts/"; fi
done
tar -czf "$output/gateway-amd64.tgz" -C "$work" packages deploy scripts
mkdir "$work/unpacked"
tar -xzf "$output/gateway-amd64.tgz" -C "$work/unpacked"
(cd "$work/unpacked/packages/reach-rpc" && npm ci --omit=dev --ignore-scripts)
[[ "$(node "$work/unpacked/packages/reach-rpc/dist/gateway-main.js" --version)" == "$version" ]]
