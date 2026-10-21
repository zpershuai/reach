#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output="${1:-$repo_root/.reach/release}"
mkdir -p "$output"
output="$(cd "$output" && pwd)"
cd "$repo_root"
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64)
    target=x86_64-unknown-linux-musl
    asset=engine-linux-x64-musl
    if [[ -z "${CC_x86_64_unknown_linux_musl:-}" ]]; then
      if command -v musl-gcc >/dev/null; then
        export CC_x86_64_unknown_linux_musl=musl-gcc
      elif [[ -x /lib/ld-musl-x86_64.so.1 ]]; then
        export CC_x86_64_unknown_linux_musl=cc
      else
        echo "Install musl-tools before packaging the Linux Engine." >&2
        exit 1
      fi
    fi
    ;;
  Darwin/arm64) target=aarch64-apple-darwin; asset=engine-darwin-arm64 ;;
  Darwin/x86_64) target=x86_64-apple-darwin; asset=engine-darwin-x64 ;;
  *) echo "Unsupported Engine packaging platform" >&2; exit 1 ;;
esac
# Keep developer accounts and absolute build paths out of distributed binaries.
export CARGO_ENCODED_RUSTFLAGS="$(python3 - "$repo_root" <<'FLAGS'
import os, sys
from pathlib import Path
existing = os.environ.get('CARGO_ENCODED_RUSTFLAGS')
flags = existing.split('\x1f') if existing else os.environ.get('RUSTFLAGS', '').split()
flags += ['--remap-path-prefix=' + sys.argv[1] + '=.',
          '--remap-path-prefix=' + os.environ.get('CARGO_HOME', str(Path.home() / '.cargo')) + '=cargo-registry',
          '--remap-path-prefix=' + str(Path.home()) + '=builder']
print('\x1f'.join(flags), end='')
FLAGS
)"
cargo build --release --locked -p reach-rpc --bin engine --target "$target"
binary="${CARGO_TARGET_DIR:-$repo_root/target}/$target/release/engine"
[[ -x "$binary" ]]
if [[ "$target" == x86_64-unknown-linux-musl ]]; then
  file "$binary" | grep -E 'static-pie linked|statically linked'
fi
version="$(python3 -c 'import re; print(re.search(r"^version = \"([^\"]+)\"", open("crates/reach-rpc/Cargo.toml").read(), re.M).group(1))')"
[[ "$("$binary" --version)" == "$version" ]]
cp "$binary" "$output/$asset"
chmod 755 "$output/$asset"
[[ "$("$output/$asset" --version)" == "$version" ]]

compiler="$(rustc --version | cut -d' ' -f2)"
# REACH_NOTICE_ARCHIVES optionally supplies previously fetched upstream notices for offline builds.
python3 scripts/package-notices.py engine "$output" --rust-version "$compiler" --rust-target "$target" --executable "$output/$asset" \
  ${REACH_NOTICE_ARCHIVES:+--archives "$REACH_NOTICE_ARCHIVES"}
cp "$output/third-party-licenses.tgz" "$output/$asset.licenses.tgz"
cp "$output/THIRD_PARTY_NOTICES.txt" "$output/$asset.NOTICES.txt"

python3 scripts/verify-release-assets.py engine-platform "$output" --asset "$asset"
