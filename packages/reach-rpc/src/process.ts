import { z } from "zod";
import { id, relative } from "./process-contract.js";
import type { Permission } from "./index.js";
export * from "./process-contract.js";

export const processGrantSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("execute"), sessionId: id, workspace: z.string().min(1).max(4096).refine(value => !value.includes("\0") && Buffer.byteLength(value) <= 4096), script: relative, launchId: id }).strict(),
  z.object({ kind: z.literal("control"), sessionId: id, processId: id }).strict(),
]);
export type ProcessGrant = z.infer<typeof processGrantSchema>;
export type ProcessPermission = Permission;
