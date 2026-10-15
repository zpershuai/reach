import { randomUUID } from "node:crypto";
import { validateGatewayUrl, type DeviceConfig } from "./config.js";

export interface ReadySession {
  sessionId?: string;
  leaseExpiresAt?: string;
  gatewayVersion?: string;
  engineVersion?: string;
  methods?: string[];
  workspaces?: string[];
  processWorkspaces?: string[];
}

export interface SessionStatus extends ReadySession {
  status: string;
}

export interface GatewayClient {
  setClientLabel?(label: string): void;
  status(): Promise<SessionStatus>;
  openAndWait(): Promise<ReadySession>;
  renew(): Promise<ReadySession>;
  rpc(method: string, params: Record<string, unknown>, permission?: { grantId: string; kind?: "execute" | "control" }): Promise<Record<string, unknown>>;
  grant(workspace: string, path: string, method: "fs.write" | "fs.edit"): Promise<{ grantId: string }>;
  processGrant?(scope: Record<string, unknown>): Promise<{ grantId: string; kind?: "execute" | "control" }>;
  close(): Promise<void>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class SessionReplacedError extends Error {
  public constructor() { super("selected session was replaced"); }
}

export class GatewayHttpError extends Error {
  public constructor(public readonly path: string, public readonly status: number, message: string) { super(message); }

  /** Known pre-forwarding rejection: no uncertain execution to drain. */
  public get isRequestRejection(): boolean {
    if (this.path !== "/session/rpc") return false;
    return this.status === 400 || this.status === 413 || this.status === 429
      || (this.status === 409 && this.message === "duplicate requestId")
      || (this.status === 503 && (this.message === "too many pending rpcs" || this.message === "message too large"));
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isTransientTransportError(error: unknown): boolean {
  if (error instanceof DOMException) return error.name === "TimeoutError" || error.name === "AbortError";
  if (!(error instanceof TypeError) || error.message !== "fetch failed") return false;
  const cause = error.cause;
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return false;
  return ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN",
    "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(String(cause.code));
}

export class HttpGatewayClient implements GatewayClient {
  private sessionId: string | undefined;
  private clientLabel: string | undefined;

  public setClientLabel(label: string): void {
    this.clientLabel = label.replace(/[^\x20-\x7e]/g, "").slice(0, 64);
  }

  public constructor(
    private readonly device: DeviceConfig,
    private readonly readyTimeoutMs: number,
    private readonly readyPollMs: number,
    private readonly request: FetchLike = fetch,
    private readonly requestTimeoutMs = 35_000,
  ) {}

  public async openAndWait(): Promise<ReadySession> {
    const deadline = Date.now() + this.readyTimeoutMs;
    const sessionId = randomUUID();
    this.sessionId = sessionId;
    let lastStatus = "unknown";
    try {
      const opened = await this.post("/session/open", { sessionId }, this.remaining(deadline));
      // An id in the open reply acknowledges binding before polling. Legacy
      // Gateways omit it and generate their own id at heartbeat acquisition.
      this.sessionId = typeof opened.sessionId === "string" ? opened.sessionId : undefined;
      while (Date.now() < deadline) {
        const status = await this.observeStatus(deadline);
        lastStatus = status.status;
        if (this.sessionId && status.sessionId && status.sessionId !== this.sessionId) throw new SessionReplacedError();
        if (status.sessionId) this.sessionId = status.sessionId;
        if (status.status === "ready") {
          if (!status.sessionId) throw new Error("Gateway ready status returned no session id");
          return status;
        }
        await wait(Math.min(this.readyPollMs, this.remaining(deadline)));
      }
      throw new Error(`device ${this.device.id} did not become ready (last status: ${lastStatus})`);
    } catch (cause) {
      // Release our pending intent as well as a connection that arrived late.
      const readinessExpired = isTransientTransportError(cause) && Date.now() >= deadline;
      await this.close().catch(() => undefined);
      if (readinessExpired) throw new Error(`device ${this.device.id} did not become ready (last status: ${lastStatus})`, { cause });
      throw cause;
    }
  }

  public async status(): Promise<SessionStatus> {
    return this.observeStatus(Date.now() + this.requestTimeoutMs);
  }

  /** Retry only status observations within one deadline. Forwarded RPC,
   * session controls and grant issuance are never automatically replayed. */
  private async observeStatus(deadline: number): Promise<SessionStatus> {
    while (true) {
      try {
        return this.parseStatus(await this.post("/session/status", undefined, Math.min(5000, this.remaining(deadline))));
      } catch (error) {
        if (!isTransientTransportError(error) || Date.now() >= deadline) throw error;
        await wait(Math.min(this.readyPollMs, Math.max(0, deadline - Date.now())));
      }
    }
  }

  public async renew(): Promise<ReadySession> {
    const reply = await this.post("/session/renew", this.sessionBinding());
    if (typeof reply.leaseExpiresAt !== "string") throw new Error("Gateway renewal returned no lease expiry");
    return { sessionId: this.sessionId, leaseExpiresAt: reply.leaseExpiresAt };
  }

  public async rpc(method: string, params: Record<string, unknown>, permission?: { grantId: string; kind?: "execute" | "control" }): Promise<Record<string, unknown>> {
    return this.post("/session/rpc", {
      requestId: randomUUID(),
      method,
      params,
      ...this.sessionBinding(),
      ...(permission ? { permission } : {}),
    });
  }

  public async grant(workspace: string, path: string, method: "fs.write" | "fs.edit"): Promise<{ grantId: string }> {
    const reply = await this.post("/grants", { workspace, path, methods: [method] });
    if (typeof reply.grantId !== "string" || !reply.grantId) throw new Error("Gateway /grants returned no grantId");
    return { grantId: reply.grantId };
  }

  public async processGrant(scope: Record<string, unknown>): Promise<{ grantId: string; kind?: "execute" | "control" }> {
    const result = await this.post("/grants", { ...scope, ...this.sessionBinding() });
    if (typeof result.grantId !== "string") throw new Error("Gateway returned no process grant");
    return { grantId: result.grantId, kind: scope.kind as "execute" | "control" };
  }

  public async close(): Promise<void> {
    const current = await this.status();
    if (current.status === "none") {
      this.sessionId = undefined;
      return;
    }
    this.checkBinding(current);
    await this.post("/session/close", this.sessionBinding());
    const deadline = Date.now() + this.requestTimeoutMs;
    while (Date.now() < deadline) {
      const status = await this.observeStatus(deadline);
      if (status.status === "none") {
        this.sessionId = undefined;
        return;
      }
      this.checkBinding(status);
      await wait(Math.min(this.readyPollMs, this.remaining(deadline)));
    }
    throw new Error(`device ${this.device.id} did not close its session`);
  }

  private sessionBinding(): { sessionId?: string } {
    return this.sessionId ? { sessionId: this.sessionId } : {};
  }

  private checkBinding(status: SessionStatus): void {
    if (!this.sessionId) return;
    if (!status.sessionId) throw new Error("Gateway active status returned no session id");
    if (status.sessionId !== this.sessionId) throw new SessionReplacedError();
  }

  private remaining(deadline: number): number {
    return Math.max(1, Math.min(this.requestTimeoutMs, deadline - Date.now()));
  }

  private parseStatus(reply: Record<string, unknown>): SessionStatus {
    if (typeof reply.status !== "string") throw new Error("Gateway returned no session status");
    return {
      status: reply.status,
      methods: Array.isArray(reply.methods) ? reply.methods.filter((v): v is string => typeof v === "string") : undefined,
      sessionId: typeof reply.sessionId === "string" ? reply.sessionId : undefined,
      leaseExpiresAt: typeof reply.leaseExpiresAt === "string" ? reply.leaseExpiresAt : undefined,
      gatewayVersion: typeof reply.gatewayVersion === "string" ? reply.gatewayVersion : undefined,
      engineVersion: typeof reply.engineVersion === "string" ? reply.engineVersion : undefined,
    };
  }

  private async post(path: string, body?: unknown, timeoutMs = this.requestTimeoutMs): Promise<Record<string, unknown>> {
    const gatewayUrl = validateGatewayUrl(this.device.gatewayUrl).toString().replace(/\/$/, "");
    const headers: Record<string, string> = {};
    if (this.clientLabel) headers["x-reach-client"] = this.clientLabel;
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.device.controllerToken) headers.authorization = `Bearer ${this.device.controllerToken}`;
    const target = this.device.engineId ? `${path}?engineId=${encodeURIComponent(this.device.engineId)}` : path;
    const response = await this.request(`${gatewayUrl}${target}`, {
      method: "POST",
      headers,
      redirect: "error",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (isTransientTransportError(error)) throw error;
      payload = undefined;
    }
    if (!response.ok) {
      const payloadError = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>).error : undefined;
      const code = typeof payloadError === "object" && payloadError !== null ? (payloadError as Record<string, unknown>).code : undefined;
      const message = typeof payloadError === "string" ? payloadError : typeof code === "string" ? code : `Gateway ${path} failed with HTTP ${response.status}`;
      throw new GatewayHttpError(path, response.status, message);
    }
    if (typeof payload !== "object" || payload === null) throw new Error(`Gateway ${path} returned invalid JSON`);
    return payload as Record<string, unknown>;
  }
}
