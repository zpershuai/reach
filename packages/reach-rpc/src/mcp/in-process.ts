import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { GatewayHttpError, SessionReplacedError, type GatewayClient, type ReadySession, type SessionStatus } from "./gateway.js";

export interface EngineResult {
  statusCode: number;
  payload: Record<string, unknown>;
}

export interface EngineStatus extends Omit<SessionStatus, "engineVersion"> {
  lastSeenAt?: string;
  engineVersion: string | null;
}

export interface EngineApi {
  status(): EngineStatus;
  open(sessionId: string): EngineResult;
  renew(sessionId: string): EngineResult;
  close(sessionId: string): EngineResult;
  grant(sessionId: string, workspace: string, path: string, method: "fs.write" | "fs.edit"): EngineResult;
  processGrant?(sessionId: string, scope: Record<string, unknown>): EngineResult;
  rpc(body: Record<string, unknown>): Promise<EngineResult>;
}

function unwrap(path: string, result: EngineResult): Record<string, unknown> {
  if (result.statusCode >= 400) {
    const error = result.payload.error;
    const message = typeof error === "string" ? error : JSON.stringify(error);
    throw new GatewayHttpError(path, result.statusCode, message);
  }
  return result.payload;
}

/** Identity-bound calls directly into the same Engine state machine as HTTP. */
export class InProcessGatewayClient implements GatewayClient {
  private sessionId: string | undefined;
  public deadlineAt = 0;

  public constructor(private readonly api: EngineApi) {}

  public async begin(): Promise<SessionStatus> {
    const status = await this.status();
    if (this.sessionId && status.status !== "none") {
      this.checkBinding(status);
      return status;
    }
    const intent = randomUUID();
    unwrap("/session/open", this.api.open(intent));
    this.sessionId = intent;
    return this.status();
  }

  public async status(): Promise<SessionStatus> {
    const status = this.api.status();
    // Null versions are retained in public discovery but not ReadySession.
    return { ...status, engineVersion: status.engineVersion ?? undefined };
  }

  public async openAndWait(): Promise<ReadySession> {
    const status = await this.begin();
    if (status.status !== "ready") throw new Error("ENGINE_CONNECTING: Device is waking up; poll device_status.");
    return status;
  }

  public async renew(): Promise<ReadySession> {
    return unwrap("/session/renew", this.api.renew(this.boundId()));
  }

  public async rpc(method: string, params: Record<string, unknown>, permission?: { grantId: string; kind?: "execute" | "control" }): Promise<Record<string, unknown>> {
    return unwrap("/session/rpc", await this.api.rpc({
      sessionId: this.boundId(), requestId: randomUUID(), method, params,
      deadlineAt: new Date(this.deadlineAt).toISOString(),
      ...(permission ? { permission } : {}),
    }));
  }

  public async grant(workspace: string, path: string, method: "fs.write" | "fs.edit"): Promise<{ grantId: string }> {
    const result = unwrap("/grants", this.api.grant(this.boundId(), workspace, path, method));
    return { grantId: result.grantId as string };
  }

  public async processGrant(scope: Record<string, unknown>): Promise<{ grantId: string; kind?: "execute" | "control" }> {
    if (!this.api.processGrant) throw new Error("PROCESS_UNSUPPORTED");
    const result = unwrap("/grants", this.api.processGrant(this.boundId(), scope));
    return { grantId: result.grantId as string, kind: scope.kind as "execute" | "control" };
  }

  public async close(): Promise<void> {
    if (!this.sessionId) return;
    let status = await this.status();
    if (status.status !== "none") {
      this.checkBinding(status);
      unwrap("/session/close", this.api.close(this.sessionId));
    }
    while ((status = await this.status()).status !== "none") {
      this.checkBinding(status);
      if (Date.now() >= this.deadlineAt) throw new Error("DEADLINE_EXCEEDED: Engine is still closing.");
      await delay(Math.min(10, Math.max(1, this.deadlineAt - Date.now())));
    }
    this.sessionId = undefined;
  }

  public owns(sessionId: string | undefined): boolean {
    return this.sessionId !== undefined && this.sessionId === sessionId;
  }

  private boundId(): string {
    if (!this.sessionId) throw new Error("SESSION_CLOSED: Connect to the device first.");
    return this.sessionId;
  }

  private checkBinding(status: SessionStatus): void {
    if (status.sessionId !== this.sessionId) throw new SessionReplacedError();
  }
}
