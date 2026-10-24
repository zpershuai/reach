import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayEvent, GatewayEvents } from "./events.js";
import { ConsoleError } from "./auth.js";

export function serveEvents(events: GatewayEvents, request: IncomingMessage, response: ServerResponse, sessionValid: () => boolean = () => true): () => void {
  const header = request.headers["last-event-id"];
  const after = header === undefined ? 0 : Number(header);
  if (Array.isArray(header) || !Number.isSafeInteger(after) || after < 0) throw new ConsoleError(400, "Invalid Last-Event-ID", "INVALID_LAST_EVENT_ID");
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no", connection: "keep-alive" });
  response.flushHeaders();
  let unsubscribe = (): void => {};
  let timer: ReturnType<typeof setInterval> | undefined;
  const close = (): void => { unsubscribe(); if (timer) clearInterval(timer); response.off("close", close); };
  const write = (text: string): void => {
    if (response.destroyed || response.writableEnded) { close(); return; }
    if (response.writableLength > 1024 * 1024) { response.destroy(); close(); return; }
    response.write(text);
    if (response.writableLength > 1024 * 1024) { response.destroy(); close(); }
  };
  const send = (event: GatewayEvent): void => {
    if (event.type === "admin.action" && event.action === "admin.logout" && !sessionValid()) { response.destroy(); close(); return; }
    write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  response.once("close", close);
  for (const event of events.replay(after)) send(event);
  if (!response.destroyed) {
    unsubscribe = events.subscribe(send);
    timer = setInterval(() => {
      if (!sessionValid()) { response.destroy(); close(); return; }
      write(": ping\n\n");
    }, 15_000);
    timer.unref();
  }
  return close;
}
