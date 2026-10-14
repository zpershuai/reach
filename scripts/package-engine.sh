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
    export CC_x86_64_unknown_linux_musl=musl-gcc
    ;;
  Darwin/arm64) target=aarch64-apple-darwin; asset=engine-darwin-arm64 ;;
  Darwin/x86_64) target=x86_64-apple-darwin; asset=engine-darwin-x64 ;;
  *) echo "Unsupported Engine packaging platform" >&2; exit 1 ;;
esac
cargo build --release --locked -p reach-rpc --bin engine --target "$target"
binary="$repo_root/target/$target/release/engine"
[[ -x "$binary" ]]
if [[ "$target" == x86_64-unknown-linux-musl ]]; then
  file "$binary" | grep -E 'static-pie linked|statically linked'
fi
version="$(python3 -c 'import re; print(re.search(r"^version = \"([^\"]+)\"", open("crates/reach-rpc/Cargo.toml").read(), re.M).group(1))')"
[[ "$("$binary" --version)" == "$version" ]]
cp "$binary" "$output/$asset"
chmod 755 "$output/$asset"
[[ "$("$output/$asset" --version)" == "$version" ]]
