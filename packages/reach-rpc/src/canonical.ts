import { z } from "zod";
import { ContractError } from "./index.js";

const wrapperSchema = z.object({ name: z.string().min(1), arguments: z.record(z.unknown()) });

/** Exactly one compatibility wrapper is accepted before authorization. */
export function canonicalizeInvocation(method: string, params: Record<string, unknown>): { method: string; params: Record<string, unknown> } {
  if (!method.trim()) throw new ContractError();
  if (method !== "tool.call") return { method, params };
  const wrapper = wrapperSchema.safeParse(params);
  if (!wrapper.success || !wrapper.data.name.trim() || wrapper.data.name === "tool.call") throw new ContractError();
  return { method: wrapper.data.name, params: wrapper.data.arguments };
}
