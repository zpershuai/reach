#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
fixture_path="$repo_root/fixtures/fs.read.request.json"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

cd "$repo_root"
cargo run --quiet -p reach-rpc --bin roundtrip -- "$fixture_path" > "$temp_dir/rust.json"

cd "$repo_root/packages/reach-rpc"
npm run --silent build
node dist/roundtrip.js "$fixture_path" > "$temp_dir/typescript.json"

node --input-type=module - "$temp_dir/rust.json" "$temp_dir/typescript.json" <<'NODE'
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const [rustPath, typeScriptPath] = process.argv.slice(2);
const rustPayload = JSON.parse(readFileSync(rustPath, "utf8"));
const typeScriptPayload = JSON.parse(readFileSync(typeScriptPath, "utf8"));
assert.deepStrictEqual(rustPayload, typeScriptPayload);
console.log("Round 1 fixture round-trips in Rust Serde and TypeScript Zod.");
NODE
