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
npm --prefix packages/gateway-console ci --ignore-scripts
npm --prefix packages/gateway-console run build
python3 scripts/package-notices.py gateway "$output" ${REACH_NOTICE_ARCHIVES:+--archives "$REACH_NOTICE_ARCHIVES"}
mkdir -p packages/reach-rpc/dist/licenses
cp "$output/LICENSE" "$output/THIRD_PARTY_NOTICES.txt" packages/reach-rpc/dist/licenses/
cp -R "$output/LICENSES" packages/reach-rpc/dist/licenses/
version="$(node -p 'require("./packages/reach-rpc/package.json").version')"
docker build --platform linux/amd64 -f deploy/Dockerfile.gateway -t "$image" .
[[ "$(docker run --rm --platform linux/amd64 "$image" node dist/gateway-main.js --version)" == "$version" ]]
# Include manifests for a self-contained rebuild and helper installation.
mkdir -p "$work/packages/reach-rpc" "$work/deploy" "$work/scripts"
cp -R packages/reach-rpc/dist "$work/packages/reach-rpc/"
cp packages/reach-rpc/package{,-lock}.json "$work/packages/reach-rpc/"
cp deploy/compose.yaml deploy/Dockerfile.gateway "$work/deploy/"
for helper in scripts/apply-*-release.sh scripts/apply-release.py scripts/release_trust.py scripts/binary_identity.py; do
  if [[ -f "$helper" ]]; then cp "$helper" "$work/scripts/"; fi
done
cp "$output/LICENSE" "$output/THIRD_PARTY_NOTICES.txt" "$work/"
tar -czf "$output/gateway-amd64.tgz" -C "$work" packages deploy scripts LICENSE THIRD_PARTY_NOTICES.txt
mkdir "$work/unpacked"
tar -xzf "$output/gateway-amd64.tgz" -C "$work/unpacked"
(cd "$work/unpacked/packages/reach-rpc" && npm ci --omit=dev --ignore-scripts)
[[ "$(node "$work/unpacked/packages/reach-rpc/dist/gateway-main.js" --version)" == "$version" ]]

python3 scripts/verify-release-assets.py gateway "$output"

# Validate the actual image, including its embedded legal bytes, before it can be saved or published.
docker image inspect "$image" | python3 -c 'import json,sys; i=json.load(sys.stdin)[0]; assert i["Os"]=="linux" and i["Architecture"]=="amd64" and i["Config"]["Labels"]["io.reach.component"]=="gateway"'
expected_legal="$(python3 - "$output" <<'LEGAL'
import hashlib,json,sys
from pathlib import Path
root=Path(sys.argv[1]); names=['LICENSE','THIRD_PARTY_NOTICES.txt']
names += [p.relative_to(root).as_posix() for p in (root/'LICENSES').rglob('*') if p.is_file()]
print(json.dumps({name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in names}))
LEGAL
)"
docker run --rm --platform linux/amd64 -e "REACH_EXPECTED_LEGAL=$expected_legal" "$image" node --input-type=module -e '
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
for (const [name, expected] of Object.entries(JSON.parse(process.env.REACH_EXPECTED_LEGAL))) {
  if (createHash("sha256").update(readFileSync("dist/licenses/" + name)).digest("hex") !== expected) process.exit(1);
}
'
