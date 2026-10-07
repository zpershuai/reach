import assert from "node:assert/strict";
import { copyFileSync, readFileSync } from "node:fs";

// Preserve the dependency-free flat installed layout, including its import closure.
for (const module of ["config", "gateway", "server", "tools", "protocol", "invoker", "result"]) {
  const source = `../reach-rpc/dist/mcp/${module}.js`;
  const target = `dist/${module}.js`;
  copyFileSync(source, target);
  assert.ok(readFileSync(source).equals(readFileSync(target)), `MCP core copy differs: ${module}`);
}
