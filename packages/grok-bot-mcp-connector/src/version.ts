import { readFileSync } from "node:fs";

/** MCP release version; independent of the MCP protocol version. */
export const MCP_VERSION: string = JSON.parse(readFileSync(new URL("./version.json", import.meta.url), "utf8")).version;
