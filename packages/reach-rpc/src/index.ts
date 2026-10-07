import { z } from "zod";

export const PROTOCOL = "reach-rpc";
export const VERSION = "1.0";
export const INVALID_PARAMS = "INVALID_PARAMS";
export const DEFAULT_START_LINE = 1;
export const DEFAULT_MAX_LINES = 200;
export const MAX_MAX_LINES = 10_000;
export const DEFAULT_MAX_ENTRIES = 200;
export const DEFAULT_MAX_RESULTS = 200;
export const DEFAULT_MAX_MATCHES = 100;
export const MAX_PAGE_SIZE = 10_000;

const nonEmptyString = z.string().min(1);

export const permissionSchema = z.object({
  grantId: nonEmptyString,
  kind: z.enum(["execute", "control"]).optional(),
});

export const requestEnvelopeSchema = z.object({
  type: z.literal("request"),
  protocol: z.literal(PROTOCOL),
  version: z.literal(VERSION),
  sessionId: nonEmptyString,
  requestId: nonEmptyString,
  method: nonEmptyString,
  params: z.record(z.unknown()),
  deadlineAt: z.string().datetime({ offset: true }).optional(),
  permission: permissionSchema.optional(),
});

export const MESSAGE_READY = "session.ready";
export const MESSAGE_RENEW = "session.renew";
export const MESSAGE_CLOSE = "session.close";
export const MESSAGE_CLOSED = "session.closed";

/** Machine-readable closure reasons the Engine reports to the Gateway. */
export const CLOSURE_AGENT_REQUESTED = "agent_requested";
export const CLOSURE_SESSION_COMPLETE = "session_complete";
export const CLOSURE_LEASE_EXPIRED = "lease_expired";
export const CLOSURE_IDLE_TIMEOUT = "idle_timeout";
export const CLOSURE_ROTATION = "rotation";
export const CLOSURE_DISCONNECTED = "disconnected";
export const CLOSURE_SHUTDOWN = "shutdown";

const rfc3339Timestamp = z.string().datetime({ offset: true });

export const sessionReadySchema = z.object({
  type: z.literal(MESSAGE_READY),
  protocol: z.literal(PROTOCOL),
  version: z.literal(VERSION),
  sessionId: nonEmptyString,
  engineId: nonEmptyString,
  engineVersion: nonEmptyString.optional(),
  workspaces: z.array(nonEmptyString).min(1),
  methods: z.array(nonEmptyString).min(1),
});

export const sessionRenewSchema = z.object({
  type: z.literal(MESSAGE_RENEW),
  sessionId: nonEmptyString,
  leaseExpiresAt: rfc3339Timestamp,
});

export const sessionCloseSchema = z.object({
  type: z.literal(MESSAGE_CLOSE),
  sessionId: nonEmptyString,
  reason: nonEmptyString,
});

export const sessionClosedSchema = z.object({
  type: z.literal(MESSAGE_CLOSED),
  sessionId: nonEmptyString,
  reason: nonEmptyString,
});

export const sessionMessageSchema = z.discriminatedUnion("type", [
  sessionReadySchema,
  sessionRenewSchema,
  sessionCloseSchema,
  sessionClosedSchema,
]);

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
    deadlineAt: rfc3339Timestamp.optional(),
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

const workspacePathSchema = z.object({
  workspace: nonEmptyString,
  path: nonEmptyString,
});

const optionalRevision = z.string().regex(/^[a-f0-9]{64}$/).optional();

export const fsWriteParamsSchema = workspacePathSchema.extend({
  content: z.string(),
  mode: z.enum(["overwrite", "create"]),
  ifMatch: optionalRevision,
});

export const fsWriteResultSchema = z.object({
  path: nonEmptyString,
  bytesWritten: z.number().int().nonnegative(),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
});

export const fsEditParamsSchema = workspacePathSchema.extend({
  oldString: nonEmptyString,
  newString: z.string(),
  replaceAll: z.boolean().default(false),
  ifMatch: optionalRevision,
});

export const fsEditResultSchema = z.object({
  path: nonEmptyString,
  replacements: z.number().int().positive(),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
});

export const fsListParamsSchema = z.object({
  workspace: nonEmptyString,
  path: nonEmptyString.default("."),
  maxEntries: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_MAX_ENTRIES),
  cursor: nonEmptyString.optional(),
});

export const fsListResultSchema = z.object({
  entries: z.array(z.object({
    name: nonEmptyString,
    path: nonEmptyString,
    type: z.enum(["file", "directory", "symlink"]),
  })),
  cursor: nonEmptyString.optional(),
  truncated: z.boolean(),
});

export const fsGlobParamsSchema = z.object({
  workspace: nonEmptyString,
  pattern: nonEmptyString,
  path: nonEmptyString.default("."),
  maxResults: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_MAX_RESULTS),
  respectGitignore: z.boolean().default(true),
  cursor: nonEmptyString.optional(),
});

export const fsGlobResultSchema = z.object({
  matches: z.array(nonEmptyString),
  cursor: nonEmptyString.optional(),
  truncated: z.boolean(),
});

export const fsStatParamsSchema = workspacePathSchema;

export const fsStatResultSchema = z.object({
  type: z.enum(["file", "directory", "symlink"]),
  size: z.number().int().nonnegative(),
  mtime: z.string().datetime(),
  revision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

export const fsGrepParamsSchema = z.object({
  workspace: nonEmptyString,
  pattern: nonEmptyString,
  path: nonEmptyString.default("."),
  include: z.array(nonEmptyString).default([]),
  maxMatches: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_MAX_MATCHES),
  cursor: nonEmptyString.optional(),
});

export const fsGrepResultSchema = z.object({
  matches: z.array(z.object({
    path: nonEmptyString,
    line: z.number().int().positive(),
    content: z.string(),
  })),
  cursor: nonEmptyString.optional(),
  truncated: z.boolean(),
});

export type Permission = z.infer<typeof permissionSchema>;
export type RequestEnvelope = z.infer<typeof requestEnvelopeSchema>;
export type FsReadParams = z.infer<typeof fsReadParamsSchema>;
export type FsReadRequest = z.infer<typeof fsReadRequestSchema>;
export type FsReadResult = z.infer<typeof fsReadResultSchema>;
export type FsWriteParams = z.infer<typeof fsWriteParamsSchema>;
export type FsWriteResult = z.infer<typeof fsWriteResultSchema>;
export type FsEditParams = z.infer<typeof fsEditParamsSchema>;
export type FsEditResult = z.infer<typeof fsEditResultSchema>;
export type FsListParams = z.infer<typeof fsListParamsSchema>;
export type FsListResult = z.infer<typeof fsListResultSchema>;
export type FsGlobParams = z.infer<typeof fsGlobParamsSchema>;
export type FsGlobResult = z.infer<typeof fsGlobResultSchema>;
export type FsStatParams = z.infer<typeof fsStatParamsSchema>;
export type FsStatResult = z.infer<typeof fsStatResultSchema>;
export type FsGrepParams = z.infer<typeof fsGrepParamsSchema>;
export type FsGrepResult = z.infer<typeof fsGrepResultSchema>;
export type SessionReady = z.infer<typeof sessionReadySchema>;
export type SessionRenew = z.infer<typeof sessionRenewSchema>;
export type SessionClose = z.infer<typeof sessionCloseSchema>;
export type SessionClosed = z.infer<typeof sessionClosedSchema>;
export type SessionMessage = z.infer<typeof sessionMessageSchema>;

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

export function parseRequestEnvelope(input: unknown): RequestEnvelope {
  const parsed = requestEnvelopeSchema.safeParse(input);
  if (!parsed.success) throw new ContractError();
  return parsed.data;
}

export const parseFsReadParams = (input: unknown): FsReadParams => parseParams(fsReadParamsSchema, input);

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

function parseParams<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ContractError();
  return parsed.data;
}

export const parseFsWriteParams = (input: unknown): FsWriteParams => parseParams(fsWriteParamsSchema, input);
export const parseFsEditParams = (input: unknown): FsEditParams => parseParams(fsEditParamsSchema, input);
export const parseFsListParams = (input: unknown): FsListParams => parseParams(fsListParamsSchema, input);
export const parseFsGlobParams = (input: unknown): FsGlobParams => parseParams(fsGlobParamsSchema, input);
export const parseFsStatParams = (input: unknown): FsStatParams => parseParams(fsStatParamsSchema, input);
export const parseFsGrepParams = (input: unknown): FsGrepParams => parseParams(fsGrepParamsSchema, input);

export const parseSessionReady = (input: unknown): SessionReady => parseParams(sessionReadySchema, input);
export const parseSessionRenew = (input: unknown): SessionRenew => parseParams(sessionRenewSchema, input);
export const parseSessionClose = (input: unknown): SessionClose => parseParams(sessionCloseSchema, input);
export const parseSessionClosed = (input: unknown): SessionClosed => parseParams(sessionClosedSchema, input);

/** Parse any session control message, rejecting unknown or malformed types. */
export function parseSessionMessage(input: unknown): SessionMessage {
  const parsed = sessionMessageSchema.safeParse(input);
  if (!parsed.success) throw new ContractError();
  return parsed.data;
}

export function serializeSessionMessage(message: SessionMessage): string {
  return JSON.stringify(parseSessionMessage(message));
}

export * from "./process-contract.js";
