import { z } from "zod";

const permissionSchema = z.object({
  engineId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  workspace: z.string().min(1).refine(value => value.trim().length > 0 && !/[\x00-\x1f\x7f*]/.test(value)),
  read: z.boolean(), write: z.boolean(), execute: z.boolean(),
}).strict();

export type ClientPermission = z.infer<typeof permissionSchema>;
export type OperationClass = "read" | "write" | "execute";

const operations: Readonly<Record<string, OperationClass>> = {
  "fs.read": "read", "fs.list": "read", "fs.stat": "read", "fs.glob": "read", "fs.grep": "read",
  "fs.write": "write", "fs.edit": "write",
  "process.run": "execute", "process.status": "execute", "process.logs": "execute", "process.list": "execute", "process.stop": "execute",
};

export function operationClass(method: string): OperationClass | undefined {
  return Object.hasOwn(operations, method) ? operations[method] : undefined;
}

export function parseClientPermissions(value: unknown): ClientPermission[] {
  const permissions = z.array(permissionSchema).parse(value);
  const seen = new Set<string>();
  for (const permission of permissions) {
    const key = JSON.stringify([permission.engineId, permission.workspace]);
    if (seen.has(key)) throw new z.ZodError([{ code: "custom", path: [], message: "Duplicate client resource permission" }]);
    seen.add(key);
  }
  return permissions;
}

export function permits(permissions: readonly ClientPermission[], engineId: string, workspace: string, method: string): boolean {
  const operation = operationClass(method);
  return operation !== undefined && permissions.some(permission => permission.engineId === engineId && permission.workspace === workspace && permission[operation]);
}

export function visibleWorkspaces(permissions: readonly ClientPermission[], engineId: string): string[] {
  return permissions.filter(permission => permission.engineId === engineId && (permission.read || permission.write || permission.execute)).map(permission => permission.workspace);
}
