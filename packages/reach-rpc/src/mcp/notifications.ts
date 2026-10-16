import type { ServerResponse } from "node:http";

const maxBufferedBytes = 1024 * 1024;

/** One replaceable notification stream per MCP session; POST replies stay on POST. */
export class McpNotifications {
  private response: ServerResponse | undefined;
  private stopStream: (() => void) | undefined;
  private initialized = false;
  private pending = true;

  ready(): void {
    this.initialized = true;
    this.flush();
  }

  toolsChanged(): void {
    this.pending = true;
    this.flush();
  }

  attach(response: ServerResponse, authorized: () => boolean, heartbeatMs = 15_000): void {
    this.close();
    this.response = response;
    // A reconnect may carry a cached catalog from an older Gateway release.
    this.pending = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const detach = (): void => {
      if (timer) clearInterval(timer);
      response.off("close", detach);
      if (this.response === response) {
        this.response = undefined;
        this.stopStream = undefined;
      }
    };
    this.stopStream = () => { detach(); response.end(); };
    response.once("close", detach);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    });
    response.flushHeaders();
    const valid = (): boolean => {
      try { return authorized(); }
      catch { return false; }
    };
    if (!valid()) { this.close(); return; }
    timer = setInterval(() => {
      if (!valid()) { this.close(); return; }
      this.write(": ping\n\n");
    }, heartbeatMs);
    timer.unref();
    this.flush();
  }

  close(): void { this.stopStream?.(); }

  private flush(): void {
    if (!this.initialized || !this.pending) return;
    if (this.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n')) this.pending = false;
  }

  private write(message: string): boolean {
    const response = this.response;
    if (!response) return false;
    if (response.destroyed || response.writableEnded || response.writableLength > maxBufferedBytes) {
      this.close();
      response.destroy();
      return false;
    }
    try {
      response.write(message);
      if (response.writableLength > maxBufferedBytes) {
        this.close();
        response.destroy();
        return false;
      }
      return true;
    } catch {
      this.close();
      response.destroy();
      return false;
    }
  }
}
