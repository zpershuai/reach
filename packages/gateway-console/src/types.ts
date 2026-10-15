export interface Hardware {
  kind: string;
  model: string;
  os: string;
  osVersion: string;
  arch: string;
}
export interface Engine {
  id: string;
  displayName: string;
  origin: "seed" | "console";
  createdAt: number;
  hardware: Hardware | null;
  deviceOverride: { kind: string; model: string } | null;
  effectiveHardware: Partial<Hardware> | null;
  lastSeenAt: number | null;
  engineVersion: string | null;
  online: boolean;
  enrollmentStatus: "awaiting_heartbeat" | "connected";
  session: {
    status: string;
    sessionId?: string;
    ownerLabel?: string;
    methods?: string[];
    workspaces?: string[];
    processWorkspaces?: string[];
  };
}
export interface Client {
  label: string;
  type: string;
  verified: false;
  lastSeenAt: number;
  activeSessions: number;
  ownedEngines: string[];
  calls24h: number;
  errors24h: number;
}
export type EventType =
  | "rpc.started"
  | "rpc.finished"
  | "rpc.denied"
  | "session.state"
  | "engine.heartbeat"
  | "client.connected"
  | "client.disconnected"
  | "auth.failed"
  | "admin.action";
export interface LiveEvent {
  id: number;
  ts: number;
  type: EventType;
  engineId?: string;
  requestId?: string;
  method?: string;
  methodClass?: string;
  caller?: { type: string; label: string; verified: false };
  status?: string;
  sessionId?: string;
  ownerLabel?: string;
  workspaces?: string[];
  processWorkspaces?: string[];
  outcome?: string;
  stage?: string;
  latencyMs?: number;
  responseBytes?: number;
  hardware?: Hardware | null;
  engineVersion?: string;
  intervalSeconds?: number;
  action?: string;
  reason?: string;
  workspace?: string;
  path?: string;
  script?: string;
  processId?: string;
  launchId?: string;
  code?: string;
}
export interface Activity extends Omit<LiveEvent, "type"> {
  type?: EventType;
  eventType?: string;
  clientLabel?: string;
  clientType?: string;
}
export interface Snapshot {
  ts: number;
  eventId: number;
  engines: Engine[];
  clients: Client[];
  activity: Activity[];
  gateway: {
    version: string;
    mcpVersion: string;
    publicOrigin: string;
    heartbeatInterval: number;
    updateEnabled: boolean;
    warnings: string[];
  };
  settings: {
    retentionDays: number;
    theme: "light" | "dark" | "system";
    heartbeatDisplay: boolean;
  };
  kpis: {
    clients: number;
    registeredEngines: number;
    onlineEngines: number;
    activeMcpSessions: number;
    requestsPerMinute: number;
    errorRate5m: number;
    policyDenialsToday: number;
  };
}
