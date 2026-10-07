import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { CLOSURE_AGENT_REQUESTED, CLOSURE_DISCONNECTED, MESSAGE_CLOSE, MESSAGE_RENEW } from "./index.js";
import { GATEWAY_VERSION } from "./version.js";
export interface PendingSession {
  token: string;
  /** Token expiry (epoch ms). The token is single-use and short-lived. */
  expiresAt: number;
  sessionId: string;
  /** Absolute lease expiry (epoch ms) for the wanted session. */
  leaseExpiresAt: number;
}

export interface LiveSession {
  sessionId: string;
  socket: WebSocket;
  /** True once the Engine has sent a valid `session.ready`. */
  ready: boolean;
  methods?: string[];
  /** True while draining after close/expiry: no new data-plane requests. */
  closed: boolean;
  leaseExpiresAt: number;
}

const isoDate = (epochMs: number): string => new Date(epochMs).toISOString();
/** Per-Engine lease, readiness and ownership state shared by REST and MCP. */
export class EngineSessionState {
  public sessionWanted = false;
  public wantedSessionId: string | undefined;
  public pendingSession: PendingSession | undefined;
  public liveSession: LiveSession | undefined;
  // Last version advertised by the configured Engine; not an online-status indicator.
  public engineVersion: string | undefined;
  public lastSeenAt: string | undefined;
  /** Last Engine-reported or observed closure reason, kept for session status. */
  public lastClosureReason: string | undefined;
  public leaseTimer: ReturnType<typeof setTimeout> | undefined;
  public idleTimer: ReturnType<typeof setTimeout> | undefined;
  public resetIdleTimer: (() => void) | undefined;
  constructor(
    private readonly now: () => number,
    private readonly logger: (message: string) => void,
    private readonly sessionLeaseMs: number,
    private readonly sessionEndpoint: string,
  ) {}
  public closeLiveSession = (code: number, reason: string) => {
    const session = this.liveSession;
    if (session && (session.socket.readyState === WebSocket.OPEN || session.socket.readyState === WebSocket.CONNECTING)) {
      // Reject new data-plane requests immediately rather than waiting for the close event.
      session.closed = true;
      session.socket.close(code, reason);
    }
  };

  public openSession = (sessionId?: string) => {
    if (this.liveSession) {
      return { statusCode: 409 as const, payload: { error: "session already active" } };
    }
    if (this.sessionWanted) {
      if (sessionId && sessionId !== this.wantedSessionId) {
        return { statusCode: 409 as const, payload: { error: "session binding mismatch" } };
      }
      // Retrying the same intent must preserve its pending token and lease.
      return { statusCode: 200 as const, payload: { wanted: true, status: "wanted" } };
    }
    this.sessionWanted = true;
    this.wantedSessionId = sessionId ?? randomUUID();
    this.pendingSession = undefined;
    this.lastClosureReason = undefined;
    return { statusCode: 200 as const, payload: { wanted: true, status: "wanted" } };
  };

  public requestClose = () => {
    if (!this.sessionWanted && !this.liveSession) {
      return { statusCode: 409 as const, payload: { error: "no session" } };
    }
    const session = this.liveSession;
    if (session) {
      session.closed = true;
      this.sessionWanted = false;
      try {
        session.socket.send(JSON.stringify({
          type: MESSAGE_CLOSE,
          sessionId: session.sessionId,
          reason: CLOSURE_AGENT_REQUESTED,
        }));
      } catch {
        this.lastClosureReason = CLOSURE_DISCONNECTED;
        this.closeLiveSession(1011, "session close delivery failed");
        return { statusCode: 503 as const, payload: { error: "session close delivery failed" } };
      }
      this.logger("Reach session close requested");
      return {
        statusCode: 200 as const,
        payload: { sessionId: session.sessionId, status: "closing", reason: CLOSURE_AGENT_REQUESTED },
      };
    }
    this.sessionWanted = false;
    this.wantedSessionId = undefined;
    this.pendingSession = undefined;
    return { statusCode: 200 as const, payload: { status: "none" } };
  };

  public renewSession = () => {
    const session = this.liveSession;
    if (!session || !session.ready || session.closed || session.socket.readyState !== WebSocket.OPEN) {
      return { statusCode: 409 as const, payload: { error: "no session" } };
    }
    // A renewal always re-bases on the present moment and is capped by the
    // Gateway policy maximum (the lease length). It cannot extend the lease.
    const leaseExpiresAt = this.now() + this.sessionLeaseMs;
    session.leaseExpiresAt = leaseExpiresAt;
    try {
      session.socket.send(JSON.stringify({
        type: MESSAGE_RENEW,
        sessionId: session.sessionId,
        leaseExpiresAt: isoDate(leaseExpiresAt),
      }));
    } catch {
      this.lastClosureReason = CLOSURE_DISCONNECTED;
      this.closeLiveSession(1011, "session renew delivery failed");
      return { statusCode: 503 as const, payload: { error: "session renew delivery failed" } };
    }
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = setTimeout(this.sessionLimitReached, Math.max(0, leaseExpiresAt - this.now()));
    this.resetIdleTimer?.();
    this.logger("Reach session renewed");
    return { statusCode: 200 as const, payload: { sessionId: session.sessionId, leaseExpiresAt: isoDate(leaseExpiresAt) } };
  };

  public sessionLimitReached = () => {
    this.closeLiveSession(1008, "session limit exceeded");
  };

  public sessionStatus = () => {
    const session = this.liveSession;
    let status = "none";
    if (session) {
      if (session.closed) status = "closing";
      else if (session.ready) status = "ready";
      else status = "connecting";
    } else if (this.sessionWanted) {
      status = this.pendingSession ? "pending" : "wanted";
    }
    return {
      gatewayVersion: GATEWAY_VERSION,
      lastSeenAt: this.lastSeenAt,
      engineVersion: this.engineVersion ?? null,
      methods: session?.methods,
      wanted: this.sessionWanted,
      status,
      sessionId: session?.sessionId ?? this.pendingSession?.sessionId ?? this.wantedSessionId,
      endpoint: this.pendingSession && !session ? this.sessionEndpoint : undefined,
      leaseExpiresAt: (session ?? this.pendingSession) ? isoDate((session ?? this.pendingSession)!.leaseExpiresAt) : undefined,
      closureReason: this.lastClosureReason,
    };
  };

}
