#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fixture=0
prefix=
if [ "${REACH_INSTALL_TEST_MODE:-}" = 1 ]; then
  prefix=${REACH_INSTALL_TEST_ROOT:?Isolated fixture root required}
  case "$prefix" in /*) ;; *) exit 1 ;; esac
  case "$prefix" in *[!A-Za-z0-9_./-]*) exit 1 ;; esac
  [ -f "$prefix/.reach-installer-fixture" ] || exit 1
  fixture=1
elif [ "$(id -u)" != 0 ] || [ ! -f /etc/openwrt_release ] || [ "$(uname -m)" != x86_64 ] || [ ! -e /lib/ld-musl-x86_64.so.1 ]; then
  echo 'This installer requires x86_64 OpenWrt with musl and a root session.' >&2
  exit 1
fi
engine_source=${1:?Usage: install-engine-openwrt.sh ENGINE_BINARY ENGINE_ENV NODE_BUNDLE}
config_source=${2:?Engine configuration required}
archive=${3:?Prepared Node bundle required}
service_name=${REACH_PROCD_SERVICE:-reach-engine}
case "$service_name" in ''|*[!A-Za-z0-9_-]*) exit 1 ;; esac
reach_dir=$prefix/root/.reach
runtime_dir=$reach_dir/runtime
config_dir=$prefix/etc/reach
service_file=$prefix/etc/init.d/$service_name
manifest=$script_dir/node-runtime.json
if [ "$fixture" = 1 ]; then manifest=$prefix/node-runtime.json; fi
node_version=$(jsonfilter -i "$manifest" -e '@.version')
node_checksum=$(jsonfilter -i "$manifest" -e '@.sha256["openwrt-x64"]')
[ -f "$config_source" ] && [ -f "$script_dir/run-node.sh" ] && [ -n "$node_version" ] && [ -n "$node_checksum" ]
case "$node_checksum" in *[!a-fA-F0-9]*|'') exit 1 ;; esac
[ "${#node_checksum}" = 64 ]
case "$node_version" in v[0-9]*.[0-9]*.[0-9]*) ;; *) exit 1 ;; esac
case "$node_version" in *[!v0-9.]*) exit 1 ;; esac
printf '%s\n' "$node_version" | grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' || exit 1
sh "$script_dir/verify-elf-x64.sh" "$engine_source"
if [ "$fixture" = 1 ]; then engine_version=$("$prefix/probe" "$engine_source" --version); else engine_version=$("$engine_source" --version 2>/dev/null); fi
case "$engine_version" in *[!0-9.]*|'') echo 'ENGINE_VERSION_REJECTED' >&2; exit 1 ;; esac
printf '%s\n' "$engine_version" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' || exit 1
/bin/sh -n "$config_source"
printf '%s  %s\n' "$node_checksum" "$archive" | sha256sum -c - >/dev/null
mkdir -p "$runtime_dir" "$config_dir" "$reach_dir/workspace" "$(dirname "$service_file")"
chmod 700 "$reach_dir" "$runtime_dir" "$config_dir"
staging=$(mktemp -d "$runtime_dir/.node-install.XXXXXX")
backup=$reach_dir/backups/openwrt-${staging##*.}
mkdir -p "$backup"
chmod 700 "$backup"
active=0
enabled=0
touched=0
complete=0
new_runtime=
service() {
  if [ "$fixture" = 1 ]; then "$prefix/supervisor" "$@"; else "$service_file" "$@"; fi
}
checkpoint() {
  if [ "$fixture" = 1 ] && [ "${REACH_INSTALL_FAIL_AT:-}" = "$1" ]; then return 1; fi
}
# The list is private operational state; target paths never enter public reports.
printf '%s\n' "$reach_dir/engine" "$reach_dir/start-engine.sh" "$reach_dir/run-node.sh" "$reach_dir/versions.json" "$config_dir/engine.env" "$service_file" "$runtime_dir/node" "$reach_dir/engine-supervisor.mjs" > "$backup/targets"
chmod 600 "$backup/targets"
rollback() {
  failures=0
  if [ "$touched" = 1 ]; then
    service stop >/dev/null 2>&1 || failures=1
    service disable >/dev/null 2>&1 || failures=1
    index=0
    while IFS= read -r target; do
      index=$((index + 1))
      restore=$target.restore-${staging##*.}
      rm -f "$restore"
      if [ -f "$backup/$index.link" ]; then
        ln -s "$(cat "$backup/$index.link")" "$restore" && mv -Tf "$restore" "$target" || failures=1
      elif [ -f "$backup/$index" ]; then
        cp -p "$backup/$index" "$restore" && mv -f "$restore" "$target" || failures=1
      else
        rm -f "$target" || failures=1
      fi
    done < "$backup/targets"
    if [ "$enabled" = 1 ]; then service enable >/dev/null 2>&1 || failures=1; fi
    if [ "$active" = 1 ]; then service start >/dev/null 2>&1 && service status >/dev/null 2>&1 || failures=1; fi
  fi
  if [ "$failures" = 0 ] && [ -n "$new_runtime" ]; then rm -rf "$new_runtime"; fi
  if [ "$failures" != 0 ]; then echo 'INSTALL_ROLLBACK_FAILED: retain private OpenWrt backup and follow recovery guide' >&2; fi
}
cleanup() {
  result=$?
  trap - EXIT INT TERM
  if [ "$complete" != 1 ]; then rollback; fi
  while IFS= read -r target; do rm -f "$target.new-${staging##*.}"; done < "$backup/targets"
  rm -rf "$staging"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 1' INT TERM
if [ -x "$service_file" ] || [ "$fixture" = 1 ]; then
  if service status >/dev/null 2>&1; then active=1; fi
  if service enabled >/dev/null 2>&1; then enabled=1; fi
fi
printf 'active=%s\nenabled=%s\n' "$active" "$enabled" > "$backup/service-state"
chmod 600 "$backup/service-state"
index=0
while IFS= read -r target; do
  index=$((index + 1))
  if [ -L "$target" ]; then readlink "$target" > "$backup/$index.link"; chmod 600 "$backup/$index.link"
  elif [ -f "$target" ]; then cp -p "$target" "$backup/$index"
  elif [ -e "$target" ]; then echo 'Unsupported existing installation target' >&2; exit 1
  fi
done < "$backup/targets"
checkpoint snapshot
distribution=node-$node_version-linux-x64-musl
# Reject archive path traversal before extraction; the full archive digest was already verified.
tar -tzf "$archive" | awk -v root="$distribution/" 'index($0,root)!=1 || $0 ~ /(^|\/)\.\.(\/|$)/ || $0 ~ /^\// { bad=1 } END { exit bad }'
tar -xzf "$archive" -C "$staging"
node=$staging/$distribution/bin/node
loader=$staging/$distribution/lib/ld-musl-x86_64.so.1
sh "$script_dir/verify-elf-x64.sh" "$node"
sh "$script_dir/verify-elf-x64.sh" "$loader"
probe_node() {
  if [ "$fixture" = 1 ]; then "$prefix/probe" "$node" "$@"; else "$loader" --library-path "$staging/$distribution/lib" "$node" "$@" 2>/dev/null; fi
}
[ "$(probe_node --version)" = "$node_version" ]
[ "$(probe_node -p 'process.platform + "-" + process.arch')" = linux-x64 ]
[ -f "$staging/$distribution/bin/npm" ] && [ -f "$staging/$distribution/bin/npx" ]
new_runtime=$runtime_dir/$distribution-${staging##*.}
[ ! -e "$new_runtime" ]
mv "$staging/$distribution" "$new_runtime"
checkpoint runtime
cp "$engine_source" "$reach_dir/engine.new-${staging##*.}"; chmod 755 "$reach_dir/engine.new-${staging##*.}"
cp "$script_dir/run-node.sh" "$reach_dir/run-node.sh.new-${staging##*.}"; chmod 755 "$reach_dir/run-node.sh.new-${staging##*.}"
cp "$config_source" "$config_dir/engine.env.new-${staging##*.}"; chmod 600 "$config_dir/engine.env.new-${staging##*.}"
cat > "$reach_dir/start-engine.sh.new-${staging##*.}" <<START_ENGINE
#!/bin/sh
set -eu
set -a
. "$config_dir/engine.env"
set +a
exec "$reach_dir/run-node.sh" "$reach_dir/engine-supervisor.mjs" "$reach_dir/engine"
START_ENGINE
chmod 700 "$reach_dir/start-engine.sh.new-${staging##*.}"
cat > "$service_file.new-${staging##*.}" <<PROCD
#!/bin/sh /etc/rc.common
START=95
STOP=10
USE_PROCD=1
start_service() {
  procd_open_instance
  procd_set_param command "$reach_dir/start-engine.sh"
  procd_set_param respawn 3600 5 5
  procd_set_param stdout 1
  procd_set_param stderr 1
  procd_set_param file "$config_dir/engine.env"
  procd_close_instance
}
PROCD
chmod 755 "$service_file.new-${staging##*.}"
printf '{"engineVersion":"%s","mcpVersion":null,"nodeVersion":"%s"}\n' "$engine_version" "$node_version" > "$reach_dir/versions.json.new-${staging##*.}"
chmod 600 "$reach_dir/versions.json.new-${staging##*.}"
ln -s "$(basename "$new_runtime")" "$runtime_dir/node.new-${staging##*.}"
cp "$script_dir/engine-supervisor.mjs" "$reach_dir/engine-supervisor.mjs.new-${staging##*.}"; chmod 644 "$reach_dir/engine-supervisor.mjs.new-${staging##*.}"
checkpoint prepared
touched=1
if [ "$active" = 1 ]; then service stop >/dev/null 2>&1; fi
checkpoint stop
index=0
while IFS= read -r target; do
  index=$((index + 1))
  mv -Tf "$target.new-${staging##*.}" "$target"
  checkpoint activate-$index
done < "$backup/targets"
service enable >/dev/null 2>&1
checkpoint enable
service start >/dev/null 2>&1
checkpoint start
service status >/dev/null 2>&1
checkpoint health
complete=1
echo "Installed Reach Engine $engine_version (procd) and verified Node $node_version."
