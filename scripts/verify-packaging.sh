#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || {
  echo "Packaging verification requires Linux x86_64, Docker and musl-tools." >&2
  exit 1
}
docker info >/dev/null
work="$(mktemp -d)"
container=
cleanup() {
  if [[ -n "$container" ]]; then docker rm -f "$container" >/dev/null; fi
  rm -rf "$work"
}
trap cleanup EXIT

# The CI runner supplies the musl target and compiler.
CC_x86_64_unknown_linux_musl=musl-gcc cargo build --release --locked -p reach-rpc --bin engine --target x86_64-unknown-linux-musl
engine="$repo_root/target/x86_64-unknown-linux-musl/release/engine"
file "$engine" | grep -E 'static-pie linked|statically linked'
"$engine" --version

npm --prefix packages/reach-rpc run build
image=reach-gateway:verification
docker build --platform linux/amd64 -f deploy/Dockerfile.gateway -t "$image" .
engine_version="$(python3 -c 'import re; print(re.search(r"version = \"([^\"]+)\"", open("crates/reach-rpc/Cargo.toml").read()).group(1))')"
gateway_version="$(node -p 'require("./packages/reach-rpc/package.json").version')"
[[ "$(docker run --rm "$image" node dist/gateway-main.js --version)" == "$gateway_version" ]]
container="$(docker run -d --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  -e REACH_CONTROLLER_TOKEN="$(printf 'c%.0s' {1..48})" \
  -e REACH_ENGINE_TOKEN="$(printf 'e%.0s' {1..48})" -e REACH_ENGINE_ID=fixture \
  "$image")"
docker exec "$container" node --input-type=module -e '
  async function check() {
    for (let i = 0; i < 50; i++) {
      try {
        const response = await fetch("http://127.0.0.1:8787/healthz");
        if (response.ok) return;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    process.exit(1);
  }
  await check();
'

version="$(node -p 'require("./scripts/node-runtime.json").version')"
archive="$work/node-$version-linux-x64-musl.tar.gz"
curl --fail --location --retry 3 "https://nodejs.org/dist/$version/$(basename "$archive")" -o "$archive"
for release in first second; do
  sh scripts/build-node-openwrt.sh "$archive" "$work/$release" "$image"
done
cmp "$work/first/node-$version-openwrt-x64.tar.gz" "$work/second/node-$version-openwrt-x64.tar.gz"
python3 - "$work/first" "$version" <<'VERIFY_MANIFEST'
import hashlib, json, sys
from pathlib import Path
root = Path(sys.argv[1])
manifest = json.loads((root / 'node-runtime.json').read_text())
bundle = root / manifest['bundles']['openwrt-x64']
assert manifest['version'] == sys.argv[2]
assert hashlib.sha256(bundle.read_bytes()).hexdigest() == manifest['sha256']['openwrt-x64']
VERIFY_MANIFEST
mkdir "$work/runtime"
tar -xzf "$work/first/node-$version-openwrt-x64.tar.gz" -C "$work/runtime"
cp "$engine" "$work/runtime/engine"
# A plain Debian runtime cannot supply the bundle's musl/C++ dependencies.
docker run --rm --platform linux/amd64 --network=none \
  -v "$work/runtime/node-$version-linux-x64-musl:/root/.reach/runtime/node:ro" \
  -v "$work/runtime/engine:/engine:ro" -e REACH_EXPECTED_NODE="$version" \
  -e REACH_EXPECTED_ENGINE="$engine_version" \
  debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587 \
  sh -eu -c '
    test "$(/engine --version)" = "$REACH_EXPECTED_ENGINE"
    test "$(/root/.reach/runtime/node/bin/node --version)" = "$REACH_EXPECTED_NODE"
    /root/.reach/runtime/node/bin/node -e '"'"'
      const {execFileSync} = require("node:child_process");
      const version = execFileSync(process.execPath, ["--version"], {encoding:"utf8"}).trim();
      if (version !== process.version) process.exit(1);
    '"'"'
  '
echo "Gateway container and reproducible OpenWrt Engine/Node bundle verified."
