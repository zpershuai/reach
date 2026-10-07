#!/bin/sh
set -eu

archive=${1:?Usage: build-node-openwrt.sh OFFICIAL_NODE_ARCHIVE OUTPUT_DIRECTORY [ALPINE_IMAGE]}
output=${2:?Output directory required}
image=${3:-reach-gateway:current}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
manifest=$script_dir/node-runtime.json
version=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$manifest")
checksum=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha256"]["linux-x64-musl"])' "$manifest")
printf '%s  %s\n' "$checksum" "$archive" | sha256sum -c -
[ "$(docker run --rm "$image" node --version)" = "$version" ]

mkdir -p "$output"
output=$(CDPATH= cd -- "$output" && pwd)
work=$(mktemp -d "$output/.build.XXXXXX")
container=
cleanup() {
  if [ -n "$container" ]; then docker rm "$container" >/dev/null; fi
  rm -rf "$work"
}
trap cleanup EXIT
distribution=node-$version-linux-x64-musl
tar -xzf "$archive" -C "$work"
runtime=$work/$distribution
mkdir -p "$runtime/lib"
container=$(docker create "$image")
docker cp -L "$container:/lib/ld-musl-x86_64.so.1" "$runtime/lib/ld-musl-x86_64.so.1"
docker cp -L "$container:/usr/lib/libstdc++.so.6" "$runtime/lib/libstdc++.so.6"
docker cp -L "$container:/usr/lib/libgcc_s.so.1" "$runtime/lib/libgcc_s.so.1"
ln -s ld-musl-x86_64.so.1 "$runtime/lib/libc.musl-x86_64.so.1"

# Keep both direct invocation and process.execPath child processes on the private libraries.
docker run --rm -i --memory=300m --memory-swap=600m \
  -e "REACH_NODE_DISTRIBUTION=$distribution" -e "REACH_NODE_VERSION=$version" \
  -v "$work:/work" rust:latest sh <<'PATCH_RUNTIME'
set -eu
apt-get update -qq
apt-get install -y --no-install-recommends patchelf
runtime=/work/$REACH_NODE_DISTRIBUTION
patchelf --set-interpreter /root/.reach/runtime/node/lib/ld-musl-x86_64.so.1 \
  --set-rpath '$ORIGIN/../lib' "$runtime/bin/node"
[ "$("$runtime/lib/ld-musl-x86_64.so.1" --library-path "$runtime/lib" "$runtime/bin/node" --version)" = "$REACH_NODE_VERSION" ]
PATCH_RUNTIME

bundle=$output/node-$version-openwrt-x64.tar.gz
tar -czf "$bundle" -C "$work" "$distribution"
python3 - "$manifest" "$bundle" "$output/node-runtime.json" <<'MANIFEST'
import hashlib
import json
import sys
from pathlib import Path
source, bundle, target = map(Path, sys.argv[1:])
manifest = json.loads(source.read_text())
manifest['sha256']['openwrt-x64'] = hashlib.sha256(bundle.read_bytes()).hexdigest()
manifest['bundles'] = {'openwrt-x64': bundle.name}
target.write_text(json.dumps(manifest, indent=2) + '\n')
MANIFEST
sha256sum "$bundle"
