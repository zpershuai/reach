import { createGateway } from "./gateway.js";

const port = Number(process.env.GATEWAY_PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("GATEWAY_PORT must be an integer between 1 and 65535");
}

const gateway = createGateway();
gateway.listen(port, "127.0.0.1", () => {
  console.log(`Reach gateway listening on http://127.0.0.1:${port}`);
});
