import { WebSocket } from "ws";
import { processSchemas } from "./process-contract.js";
import { canonicalizeInvocation } from "./canonical.js";
import { GrantStore } from "./grants.js";
import { ContractError, parseFsEditParams, parseFsWriteParams, parseRequestEnvelope, permissionSchema } from "./index.js";
import type { EngineResult } from "./mcp/in-process.js";
import { EngineSessionState } from "./gateway-state.js";
import { MAX_PENDING_RPCS, MAX_TIMED_OUT_REQUEST_IDS, MAX_SEEN_REQUEST_IDS, MAX_WEBSOCKET_TEXT_BYTES } from "./gateway-policy.js";
export interface PendingRpc {
  resolve: (payload: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function leafMutation(
  leaf: ReturnType<typeof canonicalizeInvocation>,
): { method: "fs.write" | "fs.edit"; params: { workspace: string; path: string } } | undefined {
  if (leaf.method !== "fs.write" && leaf.method !== "fs.edit") return undefined;
  const parsed = leaf.method === "fs.write" ? parseFsWriteParams(leaf.params) : parseFsEditParams(leaf.params);
  return { method: leaf.method, params: parsed };
}

const isoDate = (epochMs: number): string => new Date(epochMs).toISOString();
/** Fixed canonicalization, authorization, deadline and one-shot forwarding pipeline. */
export class SessionRpcForwarder {
  public readonly pendingRpcs = new Map<string, PendingRpc>();
  /** Request IDs already forwarded in the live session (including timed-out ones). */
  public readonly seenRequestIds = new Set<string>();
  /**
   * Request IDs with a timeout or uncertain session-closing outcome. Unlike
   * `seenRequestIds` — which the
   * socket close handler clears — this survives session teardown, so a
   * timed-out mutation (which the Engine may already have applied on disk)
   * cannot be re-executed by retrying the same requestId in a fresh session.
   * Bounded: oldest entries are evicted once `MAX_TIMED_OUT_REQUEST_IDS` is hit.
   */
  public readonly timedOutRequestIds = new Set<string>();
  constructor(
    private readonly state: EngineSessionState,
    private readonly grants: GrantStore,
    private readonly now: () => number,
    private readonly sessionRpcTimeoutMs: number,
  ) {}
  public noteTimedOutRequest = (requestId: string) => {
    this.timedOutRequestIds.add(requestId);
    if (this.timedOutRequestIds.size > MAX_TIMED_OUT_REQUEST_IDS) {
      const oldest = this.timedOutRequestIds.values().next().value;
      if (oldest !== undefined) this.timedOutRequestIds.delete(oldest);
    }
  };
  public noteSeenRequest = (requestId: string) => {
    this.seenRequestIds.add(requestId);
    if (this.seenRequestIds.size > MAX_SEEN_REQUEST_IDS) {
      const oldest = this.seenRequestIds.values().next().value;
      if (oldest !== undefined) this.seenRequestIds.delete(oldest);
    }
  };
  public clearPendingRpcs = (reason: string) => {
    for (const [requestId, pending] of this.pendingRpcs) {
      clearTimeout(pending.timer);
      this.noteTimedOutRequest(requestId);
      pending.reject(new Error(reason));
      this.pendingRpcs.delete(requestId);
    }
  };

  public forwardToEngine = (envelope: Record<string, unknown>, closeOnTimeout: boolean): Promise<Record<string, unknown>> => {
    const session = this.state.liveSession;
    if (!session || session.socket.readyState !== WebSocket.OPEN || session.closed) {
      return Promise.reject(new Error("no ready session"));
    }
    const requestId = envelope.requestId;
    if (typeof requestId !== "string" || !requestId) {
      return Promise.reject(new Error("missing requestId"));
    }
    if (this.pendingRpcs.has(requestId) || this.seenRequestIds.has(requestId) || this.timedOutRequestIds.has(requestId)) {
      return Promise.reject(new Error("duplicate requestId"));
    }
    if (this.pendingRpcs.size >= MAX_PENDING_RPCS) {
      return Promise.reject(new Error("too many pending rpcs"));
    }

    const payload = { ...envelope, sessionId: session.sessionId, type: "request", protocol: "reach-rpc", version: "1.0" };
    this.noteSeenRequest(requestId);
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpcs.delete(requestId);
        // Keep timed-out mutation IDs across teardown to prevent re-application.
        this.noteTimedOutRequest(requestId);
        if (!closeOnTimeout) {
          resolve({ type: "error", requestId, error: { code: "DEADLINE_EXCEEDED" } });
          return;
        }
        reject(new Error("session rpc timeout"));
        // Stop forwarding; a mutation already past its commit boundary may finish.
        this.state.closeLiveSession(1011, "session rpc timeout");
      }, Math.max(1, Date.parse(envelope.deadlineAt as string) - this.now()));
      this.pendingRpcs.set(requestId, { resolve, reject, timer });
      this.state.resetIdleTimer?.();
      try {
        const text = JSON.stringify(payload);
        if (Buffer.byteLength(text) > MAX_WEBSOCKET_TEXT_BYTES) {
          clearTimeout(timer);
          this.pendingRpcs.delete(requestId);
          this.seenRequestIds.delete(requestId);
          reject(new Error("message too large"));
          return;
        }
        session.socket.send(text);
      } catch (error) {
        clearTimeout(timer);
        this.pendingRpcs.delete(requestId);
        this.seenRequestIds.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  public executeRpc = async (body: unknown, receivedAt: number): Promise<EngineResult> => {
    // HTTP ingress limits received bytes; expanded internal envelopes use the
    // WebSocket bound in this.forwardToEngine so metadata does not shrink that limit.
    const session = this.state.liveSession;
    if (!session) {
      return { statusCode: 409, payload: { error: "no live session" } };
    }
    if (!session.ready) {
      return { statusCode: 409, payload: { error: "no ready session" } };
    }
    if (session.closed) {
      return { statusCode: 409, payload: { error: "session closed" } };
    }

    let envelope: ReturnType<typeof parseRequestEnvelope>;
    try {
      const candidate = typeof body === "object" && body !== null
        ? { type: "request", protocol: "reach-rpc", version: "1.0", sessionId: session.sessionId, ...(body as Record<string, unknown>) }
        : body;
      envelope = parseRequestEnvelope(candidate);
      if (envelope.sessionId !== session.sessionId) throw new ContractError();
    } catch {
      return { statusCode: 400, payload: { type: "error", error: { code: "INVALID_PARAMS" } } };
    }

    let invocation: ReturnType<typeof canonicalizeInvocation>;
    try {
      invocation = canonicalizeInvocation(envelope.method, envelope.params);
    } catch {
      return { statusCode: 200, payload: { type: "error", requestId: envelope.requestId, error: { code: "INVALID_PARAMS" } } };
    }
    let processKind: "execute" | "control" | undefined;
    if (invocation.method.startsWith("process.")) {
      const schema = processSchemas[invocation.method];
      if (!schema?.safeParse(invocation.params).success) return { statusCode: 200, payload: { type: "error", requestId: envelope.requestId, error: { code: "INVALID_PARAMS" } } };
      if (invocation.method === "process.run" || invocation.method === "process.stop") {
        processKind = envelope.permission ? this.grants.matchesProcess(envelope.permission.grantId, session.sessionId, invocation.method, invocation.params) : undefined;
        if (!processKind) return { statusCode: 200, payload: { type: "error", requestId: envelope.requestId, error: { code: "PERMISSION_DENIED" } } };
      }
    }
    try {
      // Reject nested/pathological `tool.call` before any grant lookup so the
      // response code never depends on grant state (kills the
      // PERMISSION_DENIED-vs-INVALID_PARAMS oracle). Single-level `tool.call`
      // remains visible to `leafMutation` for grant validation.
      const mutation = leafMutation(invocation);
      if (mutation) {
        const permission = permissionSchema.safeParse(envelope.permission);
        if (
          !permission.success
          || !this.grants.matches(permission.data.grantId, mutation.method, mutation.params.workspace, mutation.params.path)
        ) {
          return { statusCode: 200, payload: { type: "error", requestId: envelope.requestId, error: { code: "PERMISSION_DENIED" } } };
        }
      }
    } catch {
      return { statusCode: 400, payload: { type: "error", requestId: envelope.requestId, error: { code: "INVALID_PARAMS" } } };
    }

    const deadlineMs = Math.min(receivedAt + this.sessionRpcTimeoutMs, envelope.deadlineAt ? Date.parse(envelope.deadlineAt) : Infinity);
    if (deadlineMs <= this.now()) {
      return { statusCode: 200, payload: { type: "error", requestId: envelope.requestId, error: { code: "DEADLINE_EXCEEDED" } } };
    }
    try {
      const reply = await this.forwardToEngine({
        deadlineAt: isoDate(deadlineMs),
        type: "request",
        protocol: envelope.protocol,
        version: envelope.version,
        sessionId: envelope.sessionId,
        requestId: envelope.requestId,
        method: envelope.method,
        params: envelope.params,
        ...(envelope.permission ? { permission: processKind ? { grantId: envelope.permission.grantId, kind: processKind } : { grantId: envelope.permission.grantId } } : {}),
      }, deadlineMs === receivedAt + this.sessionRpcTimeoutMs);
      return { statusCode: 200, payload: reply };
    } catch (error) {
      const message = error instanceof Error ? error.message : "session rpc failed";
      const status = message === "no ready session" || message === "duplicate requestId" ? 409 : 503;
      return { statusCode: status, payload: { error: message } };
    }
  };

}
