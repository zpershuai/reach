import { randomUUID } from "node:crypto";
import type { DeviceConfig } from "./config.js";

export interface ReadySession {
  leaseExpiresAt?: string;
}

export interface GatewayClient {
  openAndWait(): Promise<ReadySession>;
  renew(): Promise<ReadySession>;
  rpc(method: string, params: Record<string, unknown>, permission?: { grantId: string }): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class HttpGatewayClient implements GatewayClient {
  public constructor(
    private readonly device: DeviceConfig,
    private readonly readyTimeoutMs: number,
    private readonly readyPollMs: number,
    private readonly request: FetchLike = fetch,
  ) {}

  public async openAndWait(): Promise<ReadySession> {
    await this.post("/session/open", {});
    const deadline = Date.now() + this.readyTimeoutMs;
    let lastStatus = "unknown";
    while (Date.now() <= deadline) {
      const status = await this.post("/session/status");
      if (typeof status.status === "string") lastStatus = status.status;
      if (status.status === "ready") {
        return { leaseExpiresAt: typeof status.leaseExpiresAt === "string" ? status.leaseExpiresAt : undefined };
      }
      await wait(this.readyPollMs);
    }
    throw new Error(`device ${this.device.id} did not become ready (last status: ${lastStatus})`);
  }

  public async renew(): Promise<ReadySession> {
    const reply = await this.post("/session/renew", {});
    return { leaseExpiresAt: typeof reply.leaseExpiresAt === "string" ? reply.leaseExpiresAt : undefined };
  }

  public async rpc(method: string, params: Record<string, unknown>, permission?: { grantId: string }): Promise<Record<string, unknown>> {
    return this.post("/session/rpc", {
      requestId: randomUUID(),
      method,
      params,
      ...(permission ? { permission } : {}),
    });
  }

  public async close(): Promise<void> {
    await this.post("/session/close", {});
  }

  private async post(path: string, body?: unknown): Promise<Record<string, unknown>> {
    const response = await this.request(`${this.device.gatewayUrl}${path}`, {
      method: "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
    if (!response.ok) {
      const payloadError = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>).error : undefined;
      const message = typeof payloadError === "string" ? payloadError : `Gateway ${path} failed with HTTP ${response.status}`;
      throw new Error(message);
    }
    if (typeof payload !== "object" || payload === null) throw new Error(`Gateway ${path} returned invalid JSON`);
    return payload as Record<string, unknown>;
  }
}
