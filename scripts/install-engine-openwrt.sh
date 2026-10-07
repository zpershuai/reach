#!/bin/sh
set -eu

if [ "$(id -u)" != 0 ] || [ ! -f /etc/openwrt_release ]; then
  echo 'This installer requires an OpenWrt root session.' >&2
  exit 1
fi
if [ "$(uname -m)" != x86_64 ] || [ ! -e /lib/ld-musl-x86_64.so.1 ]; then
  echo 'This installer currently supports x86_64 OpenWrt with musl.' >&2
  exit 1
fi
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
engine_source=${1:?Usage: install-engine-openwrt.sh ENGINE_BINARY ENGINE_ENV NODE_BUNDLE}
config_source=${2:?Engine configuration file required}
archive=${3:?A prepared Node bundle is required for the bundled Gateway/MCP runtime}
[ -f "$script_dir/run-node.sh" ]
engine_version=$("$engine_source" --version)
node_version=$(jsonfilter -i "$script_dir/node-runtime.json" -e '@.version')
node_checksum=$(jsonfilter -i "$script_dir/node-runtime.json" -e '@.sha256["openwrt-x64"]')
[ -f "$config_source" ] && [ -n "$node_version" ] && [ -n "$node_checksum" ]

reach_dir=/root/.reach
runtime_dir=$reach_dir/runtime
mkdir -p "$runtime_dir" /etc/reach "$reach_dir/workspace"
chmod 700 "$reach_dir" "$runtime_dir" /etc/reach "$reach_dir/workspace"
staging=$(mktemp -d "$runtime_dir/.node-install.XXXXXX")
trap 'rm -rf "$staging"' EXIT
distribution=node-$node_version-linux-x64-musl
printf '%s  %s\n' "$node_checksum" "$archive" | sha256sum -c -
tar -xzf "$archive" -C "$staging"
node=$staging/$distribution/bin/node
loader=$staging/$distribution/lib/ld-musl-x86_64.so.1
[ "$("$loader" --library-path "$staging/$distribution/lib" "$node" --version)" = "$node_version" ]
[ "$("$loader" --library-path "$staging/$distribution/lib" "$node" -p 'process.platform + "-" + process.arch')" = linux-x64 ]
[ -f "$staging/$distribution/bin/npm" ] && [ -f "$staging/$distribution/bin/npx" ]

release_stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup=$reach_dir/backups/$release_stamp
mkdir -p "$backup"
chmod 700 "$backup"
for installed in "$reach_dir/engine" "$reach_dir/start-engine.sh" "$reach_dir/run-node.sh" "$reach_dir/versions.json" /etc/reach/engine.env /etc/init.d/reach-engine; do
  if [ -f "$installed" ]; then
    cp -p "$installed" "$backup/$(basename "$installed")"
  fi
done
if [ -L "$runtime_dir/node" ]; then
  readlink "$runtime_dir/node" > "$backup/node-runtime-link"
fi

release=$distribution-${staging##*.}
mv "$staging/$distribution" "$runtime_dir/$release"
ln -s "$release" "$staging/node-link"
mv -Tf "$staging/node-link" "$runtime_dir/node"

if [ -x /etc/init.d/reach-engine ]; then
  /etc/init.d/reach-engine stop
fi
cp "$engine_source" "$reach_dir/engine.new"
chmod 755 "$reach_dir/engine.new"
mv -f "$reach_dir/engine.new" "$reach_dir/engine"
cp "$script_dir/run-node.sh" "$reach_dir/run-node.sh.new"
chmod 755 "$reach_dir/run-node.sh.new"
mv -f "$reach_dir/run-node.sh.new" "$reach_dir/run-node.sh"
cp "$config_source" /etc/reach/engine.env.new
chmod 600 /etc/reach/engine.env.new
mv -f /etc/reach/engine.env.new /etc/reach/engine.env

cat > "$reach_dir/start-engine.sh" <<'START_ENGINE'
#!/bin/sh
set -eu
set -a
. /etc/reach/engine.env
set +a
exec /root/.reach/engine
START_ENGINE
chmod 700 "$reach_dir/start-engine.sh"
cat > /etc/init.d/reach-engine <<'PROCD'
#!/bin/sh /etc/rc.common
START=95
STOP=10
USE_PROCD=1

start_service() {
  procd_open_instance
  procd_set_param command /root/.reach/start-engine.sh
  procd_set_param respawn 3600 5 5
  procd_set_param stdout 1
  procd_set_param stderr 1
  procd_set_param file /etc/reach/engine.env
  procd_close_instance
}
PROCD
chmod 755 /etc/init.d/reach-engine
"$runtime_dir/node/bin/node" -e '
  const fs = require("node:fs");
  const versions = {engineVersion: process.argv[1], mcpVersion: null, nodeVersion: process.version};
  fs.writeFileSync("/root/.reach/versions.json.new", JSON.stringify(versions, null, 2) + "\n", {mode: 0o600});
  fs.renameSync("/root/.reach/versions.json.new", "/root/.reach/versions.json");
' "$engine_version"
/etc/init.d/reach-engine enable
/etc/init.d/reach-engine start
echo "Installed Reach Engine $engine_version (procd) and Node $node_version for local Gateway/MCP processes."
