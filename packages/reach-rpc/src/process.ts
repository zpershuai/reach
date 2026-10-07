import { z } from "zod";

const id = z.string().min(1).max(128).refine(value => !value.includes("\0") && Buffer.byteLength(value) <= 128);
const relative = z.string().min(1).max(4096).refine(value => !value.startsWith("/") && !value.includes("\0") && !value.split("/").includes("..") && Buffer.byteLength(value) <= 4096);
export const processRunSchema = z.object({
  workspace: z.string().min(1).max(4096).refine(value => !value.includes("\0") && Buffer.byteLength(value) <= 4096), script: relative, launchId: id,
  args: z.array(z.string().max(4096).refine(value => !value.includes("\0") && Buffer.byteLength(value) <= 4096)).max(128).default([]),
  cwd: relative.default("."), timeoutMs: z.number().int().min(1).max(86_400_000).default(60_000),
  ifMatch: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().refine(value => value.args.reduce((sum, value) => sum + Buffer.byteLength(value), 0) <= 32768);
export const processStatusSchema = z.object({ processId: id.optional(), launchId: id.optional() }).strict().refine(value => (value.processId === undefined) !== (value.launchId === undefined));
export const processStopSchema = z.object({ processId: id }).strict();
export const processLogsSchema = z.object({ processId: id, cursor: z.string().max(4096).optional(), maxBytes: z.number().int().min(1).max(16384).optional() }).strict();
export const processListSchema = z.object({ workspace: z.string().min(1).max(4096).refine(value => !value.includes("\0") && Buffer.byteLength(value) <= 4096).optional(), cursor: z.string().max(8192).optional(), maxEntries: z.number().int().min(1).max(128).optional() }).strict();
export const processSchemas: Record<string, z.ZodTypeAny> = {
  "process.run": processRunSchema, "process.status": processStatusSchema, "process.stop": processStopSchema,
  "process.logs": processLogsSchema, "process.list": processListSchema,
};
export const processGrantSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("execute"), sessionId: id, workspace: z.string().min(1).max(4096).refine(value => !value.includes("\0") && Buffer.byteLength(value) <= 4096), script: relative, launchId: id }).strict(),
  z.object({ kind: z.literal("control"), sessionId: id, processId: id }).strict(),
]);
export type ProcessGrant = z.infer<typeof processGrantSchema>;
export interface ProcessPermission { grantId: string; kind?: "execute" | "control" }

export const processStateSchema = z.enum(["starting", "running", "stopping", "exited", "stopped", "timed_out", "failed"]);
export const processTaskSchema = z.object({
  processId: id, launchId: id, workspace: z.string(), script: z.string(), state: processStateSchema,
  startedAt: z.string().datetime({ offset: true }), deadlineAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }).nullable(), exitCode: z.number().int().nullable(),
  signal: z.number().int().nullable(), reason: z.string().nullable(),
});
export const processLogsResultSchema = z.object({
  records: z.array(z.object({ sequence: z.number().int().nonnegative(), stream: z.enum(["stdout", "stderr"]), text: z.string() })),
  nextCursor: z.string(), truncated: z.boolean(), eof: z.boolean(),
});
export const processListResultSchema = z.object({ processes: z.array(processTaskSchema), nextCursor: z.string().nullable() });
export type ProcessTask = z.infer<typeof processTaskSchema>;
