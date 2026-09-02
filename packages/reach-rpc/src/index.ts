import { z } from "zod";

export const PROTOCOL = "reach-rpc";
export const VERSION = "1.0";
export const INVALID_PARAMS = "INVALID_PARAMS";
export const DEFAULT_START_LINE = 1;
export const DEFAULT_MAX_LINES = 200;
export const MAX_MAX_LINES = 10_000;

const nonEmptyString = z.string().min(1);

export const permissionSchema = z.object({
  grantId: nonEmptyString,
});

export const fsReadParamsSchema = z.object({
  workspace: nonEmptyString,
  path: nonEmptyString,
  startLine: z.number().int().min(1).default(DEFAULT_START_LINE),
  maxLines: z.number().int().min(1).max(MAX_MAX_LINES).default(DEFAULT_MAX_LINES),
});

export const fsReadRequestSchema = z
  .object({
    type: z.literal("request"),
    protocol: z.literal(PROTOCOL),
    version: z.literal(VERSION),
    sessionId: nonEmptyString,
    requestId: nonEmptyString,
    method: z.literal("fs.read"),
    params: fsReadParamsSchema,
    permission: permissionSchema.optional(),
  });

export const fsReadResultSchema = z
  .object({
    content: z.string(),
    startLine: z.number().int().min(1),
    endLine: z.number().int().nonnegative(),
    totalLines: z.number().int().nonnegative(),
    truncated: z.boolean(),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .superRefine((result, context) => {
    if (result.endLine < result.startLine - 1) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "endLine is before startLine" });
    }
  });

export type Permission = z.infer<typeof permissionSchema>;
export type FsReadParams = z.infer<typeof fsReadParamsSchema>;
export type FsReadRequest = z.infer<typeof fsReadRequestSchema>;
export type FsReadResult = z.infer<typeof fsReadResultSchema>;

export class ContractError extends Error {
  readonly code = INVALID_PARAMS;

  constructor() {
    super(INVALID_PARAMS);
  }
}

export function parseFsReadRequest(input: unknown): FsReadRequest {
  const parsed = fsReadRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new ContractError();
  }
  return parsed.data;
}

export function parseFsReadResult(input: unknown): FsReadResult {
  const parsed = fsReadResultSchema.safeParse(input);
  if (!parsed.success) {
    throw new ContractError();
  }
  return parsed.data;
}

export function serializeRequest(request: FsReadRequest): string {
  return JSON.stringify(parseFsReadRequest(request));
}

export function serializeResult(result: FsReadResult): string {
  return JSON.stringify(parseFsReadResult(result));
}
