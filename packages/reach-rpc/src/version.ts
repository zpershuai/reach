import { readFileSync } from "node:fs";

/** Gateway release version; independent of the reach-rpc wire protocol version. */
export const GATEWAY_VERSION: string = JSON.parse(readFileSync(new URL("./version.json", import.meta.url), "utf8")).version;
