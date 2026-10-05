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
  const trimmed = path.trim();
  if (!trimmed || trimmed.startsWith("/") || trimmed.includes("\0")) return undefined;
  const parts: string[] = [];
  for (const part of trimmed.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") return undefined;
    parts.push(part);
  }
  return parts.join("/");
}

/** Gateway-owned grant issuance and scope checks use one injected clock. */
export class GrantStore {
  private readonly grants = new Map<string, WriteGrant>();

  public constructor(private readonly now: () => number) {}

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

  public matches(grantId: string, method: MutationMethod, workspace: string, path: string): boolean {
    const grant = this.grants.get(grantId);
    const requestPath = normalizeWorkspacePath(path);
    if (!grant || grant.expiresAt <= this.now() || !requestPath) return false;
    return grant.workspace === workspace && grant.methods.includes(method)
      && (requestPath === grant.path || requestPath.startsWith(`${grant.path}/`));
  }
}
