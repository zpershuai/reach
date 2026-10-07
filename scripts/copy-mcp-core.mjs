import { copyFileSync } from "node:fs";

// Keep the connector's installed, dependency-free flat distribution compatible.
// Its TypeScript re-exports use the same core while source tests are compiled.
for (const module of ["config", "gateway", "server", "tools"]) {
  copyFileSync(`../reach-rpc/dist/mcp/${module}.js`, `dist/${module}.js`);
}
