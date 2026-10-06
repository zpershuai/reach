import { readFileSync, writeFileSync } from "node:fs";

// npm runs this in the component package directory after TypeScript compilation.
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
writeFileSync("dist/version.json", JSON.stringify({ version }) + "\n");
