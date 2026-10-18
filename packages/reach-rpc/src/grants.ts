import { processGrantSchema, type ProcessGrant } from "./process.js";
import { randomUUID } from "node:crypto";

export type MutationMethod = "fs.write" | "fs.edit";
export const GRANT_TTL_MS = 5 * 60 * 1000;

interface WriteGrant {
  workspace: string;
  path: string;
  methods: readonly MutationMethod[];
  expiresAt: number;
}

/** Normalize workspace-relative grant scopes without allowing parent traversal. */
export function normalizeWorkspacePath(path: string): string | undefined {
  if (!path || path.startsWith("/") || path.includes("\0")) return undefined;
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") return undefined;
    parts.push(part);
  }
  return parts.join("/");
}

/** Gateway-owned grant issuance and scope checks use one injected clock. */
export class GrantStore {
  private readonly processGrants = new Map<string, { scope: ProcessGrant; expiresAt: number }>();
  private readonly grants = new Map<string, WriteGrant>();

  public constructor(private readonly now: () => number) {}

  public clear(): void {
    this.grants.clear();
    this.processGrants.clear();
  }

  public revokeWorkspace(workspace: string, { processOnly = false }: { processOnly?: boolean } = {}): void {
    if (!processOnly) {
      for (const [id, grant] of this.grants) {
        if (grant.workspace === workspace) this.grants.delete(id);
      }
    }
    for (const [id, grant] of this.processGrants) {
      if (grant.scope.kind === "execute" && grant.scope.workspace === workspace) this.processGrants.delete(id);
    }
  }

  public issue(workspace: string, path: string, methods: readonly MutationMethod[]): { grantId: string; expiresAt: string } {
    const normalizedPath = normalizeWorkspacePath(path);
    if (!normalizedPath) throw new Error("invalid grant path");
    const current = this.now();
    for (const [id, grant] of this.grants) {
      if (grant.expiresAt <= current) this.grants.delete(id);
    }
    const grantId = randomUUID();
    const expiresAt = current + GRANT_TTL_MS;
    this.grants.set(grantId, { workspace, path: normalizedPath, methods: [...methods], expiresAt });
    return { grantId, expiresAt: new Date(expiresAt).toISOString() };
  }

  public issueProcess(value: unknown): { grantId: string; expiresAt: string } {
    const scope = processGrantSchema.parse(value);
    if (scope.kind === "execute") {
      const path = normalizeWorkspacePath(scope.script);
      if (!path) throw new Error("invalid process entry");
      scope.script = path;
    }
    const now = this.now();
    for (const [id, grant] of this.processGrants) if (grant.expiresAt <= now) this.processGrants.delete(id);
    if (this.processGrants.size >= 4096) throw new Error("process grant limit exceeded");
    const grantId = randomUUID();
    const expiresAt = now + GRANT_TTL_MS;
    this.processGrants.set(grantId, { scope, expiresAt });
    return { grantId, expiresAt: new Date(expiresAt).toISOString() };
  }

  public matchesProcess(grantId: string, sessionId: string, method: string, params: Record<string, unknown>): "execute" | "control" | undefined {
    const grant = this.processGrants.get(grantId);
    if (!grant || grant.expiresAt <= this.now() || grant.scope.sessionId !== sessionId) return undefined;
    const scope = grant.scope;
    if (scope.kind === "control") return method === "process.stop" && scope.processId === params.processId ? "control" : undefined;
    return method === "process.run" && scope.workspace === params.workspace && typeof params.script === "string"
      && scope.script === normalizeWorkspacePath(params.script) && scope.launchId === params.launchId ? "execute" : undefined;
  }

  public matches(grantId: string, method: MutationMethod, workspace: string, path: string): boolean {
    const grant = this.grants.get(grantId);
    const requestPath = normalizeWorkspacePath(path);
    if (!grant || grant.expiresAt <= this.now() || !requestPath) return false;
    return grant.workspace === workspace && grant.methods.includes(method)
      && (requestPath === grant.path || requestPath.startsWith(`${grant.path}/`));
  }
}
