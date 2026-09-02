import { readFileSync } from "node:fs";
import { parseFsReadRequest, serializeRequest } from "./index.js";

const fixturePath = process.argv[2] ?? "../../fixtures/fs.read.request.json";
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
console.log(serializeRequest(parseFsReadRequest(fixture)));
