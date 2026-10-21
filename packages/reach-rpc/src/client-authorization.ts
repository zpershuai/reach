import { AsyncLocalStorage } from "node:async_hooks";
import { timingSafeEqual } from "node:crypto";
import { canonicalizeInvocation } from "./canonical.js";
import { operationClass, permits, visibleWorkspaces, type ClientPermission } from "./client-policy.js";
import { ClientAccess, ClientAccessError } from "./console-api/client-access.js";
import type { CallerContext, GatewayEvents } from "./console-api/events.js";
import type { GrantAuthority } from "./grants.js";
import { GatewayHttpError } from "./mcp/gateway.js";
import type { EngineApi, EngineResult, EngineStatus } from "./mcp/in-process.js";

export interface AuthenticatedPrincipal {
  readonly id: string;
  readonly kind: "owner" | "delegated" | "oauth";
  readonly revision: number;
  readonly valid: () => boolean;
}

interface Ownership {
  principalId: string;
  sessionId: string;
  api: EngineApi;
  processes: Map<string, string>;
  launches: Map<string, string>;
  retiring?: boolean;
  closeRequested?: boolean;
  cleanupWarned?: boolean;
}

function failure(statusCode: number, error: string): EngineResult {
  return { statusCode, payload: { error } };
}

function rpcError(body: Record<string, unknown>, code: string): EngineResult {
  return { statusCode: 200, payload: { type: "error", requestId: body.requestId, error: { code } } };
}

/** A request's verified identity follows asynchronous work without trusting wire fields. */
export class ClientAuthorization {
  private readonly context = new AsyncLocalStorage<AuthenticatedPrincipal>();
  private readonly issued = new WeakSet<AuthenticatedPrincipal>();
  private readonly ownership = new Map<string, Ownership>();
  private readonly maps = new Map<string, AuthorizedEngines>();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(private readonly access: ClientAccess | undefined, private readonly controllerToken: string | undefined,
    private readonly oauth: ((authorization: string | undefined) => { id: string } | undefined) | undefined,
    private readonly events?: GatewayEvents, private readonly logger: (message: string) => void = console.error) {
    this.cleanupTimer = setInterval(() => this.retryCleanup(), 500);
    this.cleanupTimer.unref();
  }

  private issue(id: string, kind: AuthenticatedPrincipal["kind"], valid: () => boolean): AuthenticatedPrincipal {
    let revision = 0;
    if (kind !== "owner" && this.access) {
      try { revision = this.access.get(id).policyRevision; }
      catch (error) { if (!(error instanceof ClientAccessError && error.status === 404)) throw error; }
    }
    const principal = Object.freeze({ id, kind, revision, valid });
    this.issued.add(principal);
    return principal;
  }

  authenticate(authorization: string | undefined, loopback: boolean): AuthenticatedPrincipal | undefined {
    if (this.controllerToken) {
      const expected = Buffer.from(`Bearer ${this.controllerToken}`);
      const actual = Buffer.from(authorization ?? "");
      if (actual.length === expected.length && timingSafeEqual(actual, expected)) return this.issue("controller", "owner", () => true);
    }
    const delegated = this.access?.authenticate(authorization);
    if (delegated) return this.issue(delegated.principalId, "delegated", () => this.access!.valid(delegated));
    const oauth = this.oauth?.(authorization);
    if (oauth) return this.issue(`oauth:${oauth.id}`, "oauth", () => this.oauth?.(authorization)?.id === oauth.id);
    if (!this.controllerToken && loopback && (!authorization || !this.access)) return this.issue("loopback", "owner", () => true);
    return undefined;
  }

  private active(principal: AuthenticatedPrincipal): boolean {
    if (this.closed) return false;
    if (!this.issued.has(principal) || !principal.valid()) return false;
    if (principal.kind === "owner" || !this.access) return true;
    try {
      const client = this.access.get(principal.id);
      return client.revokedAt === null;
    } catch (error) {
      return error instanceof ClientAccessError && error.status === 404 && principal.kind === "oauth" && principal.revision === 0;
    }
  }

  valid(principal: AuthenticatedPrincipal): boolean {
    if (!this.active(principal)) return false;
    if (principal.kind === "owner" || !this.access) return true;
    try { return this.access.get(principal.id).policyRevision === principal.revision; }
    catch (error) { return error instanceof ClientAccessError && error.status === 404 && principal.revision === 0; }
  }

  run<T>(principal: AuthenticatedPrincipal, action: () => T): T {
    if (!this.active(principal)) throw new GatewayHttpError("/authorization", 401, "Invalid or expired client credential");
    return this.context.run(principal, action);
  }

  private require(principalId: string): AuthenticatedPrincipal {
    const principal = this.context.getStore();
    if (!principal || principal.id !== principalId || !this.active(principal)) throw new GatewayHttpError("/authorization", 401, "Invalid or expired client credential");
    if (!this.valid(principal)) throw new GatewayHttpError("/policy", 403, "PERMISSION_DENIED");
    return principal;
  }

  private policy(principalId: string): { global: boolean; permissions: readonly ClientPermission[] } {
    if (principalId === "controller" || principalId === "loopback" || !this.access) return { global: true, permissions: [] };
    try {
      const client = this.access.get(principalId);
      return { global: client.revokedAt === null && client.legacyGlobal, permissions: client.revokedAt === null ? client.permissions : [] };
    } catch (error) {
      if (!(error instanceof ClientAccessError && error.status === 404)) throw error;
      return { global: false, permissions: [] };
    }
  }

  visible(principalId: string, engineId: string): boolean {
    const policy = this.policy(principalId);
    return policy.global || visibleWorkspaces(policy.permissions, engineId).length > 0;
  }

  canMethod(principalId: string, method: string): boolean {
    const operation = operationClass(method);
    const policy = this.policy(principalId);
    return operation !== undefined && (policy.global || policy.permissions.some(permission => permission[operation]));
  }

  private authority(principal: AuthenticatedPrincipal, engineId: string): GrantAuthority {
    return { principalId: principal.id, engineId, policyRevision: principal.revision };
  }

  engines(source: ReadonlyMap<string, EngineApi>, principalId: string): ReadonlyMap<string, EngineApi> {
    let map = this.maps.get(principalId);
    if (!map || map.source !== source) {
      map = new AuthorizedEngines(source, principalId, this);
      this.maps.set(principalId, map);
    }
    return map;
  }

  invalidate(principalId: string, engines: ReadonlyMap<string, EngineApi>): void {
    for (const bound of this.ownership.values()) if (bound.principalId === principalId) bound.retiring = true;
    this.maps.delete(principalId);
    for (const api of engines.values()) {
      try { api.revokePrincipal?.(principalId); }
      catch { this.warnCleanup(); }
    }
    this.retryCleanup();
  }

  private warnCleanup(): void {
    try { this.logger("Client session cleanup requires retry; authority remains blocked"); } catch { /* Preserve invalidated authority. */ }
  }

  retryCleanup(): void {
    for (const [engineId, bound] of this.ownership) {
      if (!bound.retiring) continue;
      try {
        const status = bound.api.status();
        if (status.status === "none") { this.ownership.delete(engineId); continue; }
        if (bound.closeRequested && status.status === "closing") continue;
        const result = bound.api.close(bound.sessionId);
        if (result.statusCode >= 400) throw new Error("cleanup incomplete");
        bound.closeRequested = true;
      } catch {
        if (!bound.cleanupWarned) { bound.cleanupWarned = true; this.warnCleanup(); }
      }
    }
  }

  close(): void {
    this.closed = true;
    clearInterval(this.cleanupTimer);
    this.maps.clear();
  }

  private binding(engineId: string, api: EngineApi): Ownership | undefined {
    const bound = this.ownership.get(engineId);
    if (bound && !bound.retiring && (bound.api !== api || api.status().status === "none")) {
      this.ownership.delete(engineId);
      return undefined;
    }
    return bound;
  }

  private requireOwned(engineId: string, api: EngineApi, principalId: string, sessionId?: string, cleanup = false): Ownership {
    const bound = this.binding(engineId, api);
    if (!bound || bound.api !== api || bound.principalId !== principalId || sessionId && bound.sessionId !== sessionId) throw new GatewayHttpError("/session", 409, "session binding mismatch");
    if (bound.retiring && !cleanup) throw new GatewayHttpError("/policy", 403, "PERMISSION_DENIED");
    return bound;
  }

  private view(engineId: string, api: EngineApi, principalId: string): EngineStatus {
    if (this.closed && !this.context.getStore()) return api.status();
    if (this.context.getStore()) this.require(principalId);
    const status = api.status();
    const policy = this.policy(principalId);
    const workspaces = new Set(visibleWorkspaces(policy.permissions, engineId));
    const workspaceAllowed = (workspace: string): boolean => policy.global || workspaces.has(workspace);
    const bound = this.binding(engineId, api);
    const own = bound?.api === api && bound.principalId === principalId && bound.sessionId === status.sessionId;
    const { sessionId, leaseExpiresAt, endpoint, ownerLabel: _label, ...rest } = status;
    return { ...rest,
      ...(own ? { sessionId, leaseExpiresAt, endpoint, ownerLabel: status.ownerLabel } : {}),
      workspaces: status.workspaces?.filter(workspaceAllowed),
      processWorkspaces: status.processWorkspaces?.filter(workspace => policy.global || permits(policy.permissions, engineId, workspace, "process.run")),
      methods: status.methods?.filter(method => {
        if (policy.global) return true;
        const operation = operationClass(method);
        return operation !== undefined && policy.permissions.some(permission => permission.engineId === engineId && permission[operation]);
      }),
    };
  }

  bind(engineId: string, api: EngineApi, principalId: string): EngineApi {
    const sync = (action: () => EngineResult): EngineResult => {
      try { return action(); }
      catch (error) { if (error instanceof GatewayHttpError) return failure(error.status, error.message); throw error; }
    };
    const requireVisible = (): AuthenticatedPrincipal => {
      const principal = this.require(principalId);
      if (!this.visible(principalId, engineId)) throw new GatewayHttpError("/engine", 404, "unknown or unauthorized engine");
      return principal;
    };
    const authorizeWorkspace = (workspace: unknown, method: string): void => {
      const policy = this.policy(principalId);
      if (operationClass(method) !== undefined && policy.global) return;
      if (typeof workspace !== "string" || !permits(policy.permissions, engineId, workspace, method)) throw new GatewayHttpError("/policy", 403, "PERMISSION_DENIED");
    };
    return {
      status: () => this.view(engineId, api, principalId),
      open: (sessionId, caller) => sync(() => {
        requireVisible();
        const current = this.binding(engineId, api);
        if (current?.retiring) return failure(409, "Engine cleanup is still in progress");
        if (api.status().status !== "none" && (!current || current.principalId !== principalId)) return failure(409, "ENGINE_BUSY");
        const result = api.open(sessionId, caller ? { ...caller, principalId } : undefined);
        if (result.statusCode === 200) {
          const ownedId = String(result.payload.sessionId ?? sessionId);
          if (!current) this.ownership.set(engineId, { principalId, sessionId: ownedId, api, processes: new Map(), launches: new Map() });
        }
        return result;
      }),
      renew: sessionId => sync(() => { requireVisible(); this.requireOwned(engineId, api, principalId, sessionId); return api.renew(sessionId); }),
      close: sessionId => sync(() => {
        // Cleanup owns this facade and must be able to drain revoked clients.
        if (this.context.getStore()) requireVisible();
        this.requireOwned(engineId, api, principalId, sessionId, !this.context.getStore());
        return api.close(sessionId);
      }),
      grant: (sessionId, workspace, path, methods) => sync(() => {
        const principal = requireVisible();
        if (api.status().status !== "none") this.requireOwned(engineId, api, principalId, sessionId || undefined);
        for (const method of typeof methods === "string" ? [methods] : methods) authorizeWorkspace(workspace, method);
        return api.grant(sessionId, workspace, path, methods, this.authority(principal, engineId));
      }),
      processGrant: (sessionId, scope) => sync(() => {
        const principal = requireVisible();
        const bound = this.requireOwned(engineId, api, principalId, sessionId);
        const workspace = scope.kind === "control" ? bound.processes.get(String(scope.processId)) : scope.workspace;
        authorizeWorkspace(workspace, "process.run");
        if (!api.processGrant) return failure(400, "PROCESS_UNSUPPORTED");
        return api.processGrant(sessionId, scope, this.authority(principal, engineId));
      }),
      rpc: async (body, caller, _authority, receivedAt) => {
        try {
          const principal = requireVisible();
          if (principal.kind === "owner" && api.status().status === "none") return api.rpc(body, caller && { ...caller, principalId }, this.authority(principal, engineId), receivedAt);
          const bound = this.requireOwned(engineId, api, principalId);
          if (typeof body.method !== "string" || !body.params || typeof body.params !== "object" || Array.isArray(body.params)) return rpcError(body, "INVALID_PARAMS");
          let invocation: ReturnType<typeof canonicalizeInvocation>;
          try { invocation = canonicalizeInvocation(body.method, body.params as Record<string, unknown>); }
          catch { return rpcError(body, "INVALID_PARAMS"); }
          const { method, params } = invocation;
          let workspace = params.workspace;
          if (method.startsWith("process.") && !["process.run", "process.list"].includes(method)) {
            workspace = undefined;
            if (typeof params.processId === "string") workspace = bound.processes.get(params.processId);
            else if (typeof params.launchId === "string") workspace = bound.launches.get(params.launchId);
            if (workspace === undefined && !this.policy(principalId).global) return rpcError(body, "PROCESS_NOT_FOUND");
          }
          if (method === "process.list" && workspace === undefined) {
            const policy = this.policy(principalId);
            if (!policy.global && !policy.permissions.some(permission => permission.engineId === engineId && permission.execute)) return rpcError(body, "PERMISSION_DENIED");
          } else if (principal.kind !== "owner" || operationClass(method) !== undefined) authorizeWorkspace(workspace, method);
          const launchId = method === "process.run" && typeof params.launchId === "string" ? params.launchId : undefined;
          const alreadyReserved = launchId !== undefined && bound.launches.has(launchId);
          if (launchId && !alreadyReserved && typeof workspace === "string") bound.launches.set(launchId, workspace);
          const result = await api.rpc(body, caller ? { ...caller, principalId } : undefined, this.authority(principal, engineId), receivedAt);
          const payload = result.payload.result;
          if (method === "process.run" && payload && typeof payload === "object" && "processId" in payload && typeof payload.processId === "string" && typeof workspace === "string") bound.processes.set(payload.processId, workspace);
          if (method === "process.list" && payload && typeof payload === "object" && "processes" in payload && Array.isArray(payload.processes)) {
            const policy = this.policy(principalId);
            if (!policy.global) {
              const processes = payload.processes.filter((task: unknown) => {
                if (!task || typeof task !== "object" || !("workspace" in task) || typeof task.workspace !== "string") return false;
                const ownedProcess = "processId" in task && typeof task.processId === "string" && bound.processes.get(task.processId) === task.workspace;
                const ownedLaunch = "launchId" in task && typeof task.launchId === "string" && bound.launches.get(task.launchId) === task.workspace;
                return (ownedProcess || ownedLaunch) && permits(policy.permissions, engineId, task.workspace, "process.list");
              });
              result.payload = { ...result.payload, result: { ...payload, processes } };
            }
          }
          const error = result.payload.error as { code?: string } | undefined;
          if (launchId && !alreadyReserved && error && !["DEADLINE_EXCEEDED", "RUNTIME_UNAVAILABLE"].includes(error.code ?? "")) bound.launches.delete(launchId);
          return result;
        } catch (error) {
          if (!(error instanceof GatewayHttpError)) throw error;
          this.events?.emit("rpc.denied", { engineId, caller: caller && { ...caller, principalId }, requestId: typeof body.requestId === "string" ? body.requestId : undefined, stage: "policy", outcome: "denied", code: error.status === 401 ? "UNAUTHORIZED" : "PERMISSION_DENIED" });
          return error.status === 403 ? rpcError(body, "PERMISSION_DENIED") : failure(error.status, error.message);
        }
      },
    };
  }
}

class AuthorizedEngines implements ReadonlyMap<string, EngineApi> {
  private readonly bound = new Map<string, { raw: EngineApi; api: EngineApi }>();
  readonly [Symbol.toStringTag] = "AuthorizedEngines";
  constructor(readonly source: ReadonlyMap<string, EngineApi>, private readonly principalId: string, private readonly authorization: ClientAuthorization) {}
  get size(): number { return [...this.keys()].length; }
  has(id: string): boolean { return this.source.has(id) && this.authorization.visible(this.principalId, id); }
  get(id: string): EngineApi | undefined {
    if (!this.has(id)) return undefined;
    const raw = this.source.get(id)!;
    let bound = this.bound.get(id);
    if (!bound || bound.raw !== raw) { bound = { raw, api: this.authorization.bind(id, raw, this.principalId) }; this.bound.set(id, bound); }
    return bound.api;
  }
  *entries(): MapIterator<[string, EngineApi]> { for (const id of this.keys()) yield [id, this.get(id)!]; }
  *keys(): MapIterator<string> { for (const id of this.source.keys()) if (this.has(id)) yield id; }
  *values(): MapIterator<EngineApi> { for (const [, api] of this.entries()) yield api; }
  [Symbol.iterator](): MapIterator<[string, EngineApi]> { return this.entries(); }
  forEach(callback: (value: EngineApi, key: string, map: ReadonlyMap<string, EngineApi>) => void, thisArg?: unknown): void {
    for (const [id, api] of this.entries()) callback.call(thisArg, api, id, this);
  }
}
