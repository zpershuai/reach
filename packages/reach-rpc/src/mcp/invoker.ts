import { type GatewayClient } from "./gateway.js";
import { toolError, toolText } from "./result.js";
/** Grant acquisition and one-shot RPC invocation, independent of device ownership. */
export class GrantAwareInvoker {
  constructor(private readonly release: () => Promise<unknown>, private readonly owns: (gateway: GatewayClient) => boolean) {}
  /** Common grant acquisition and RPC dispatch for both MCP transports. */
  public async call(gateway: GatewayClient, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (method.startsWith("process.")) {
      const status = await gateway.status();
      if (!status.methods?.includes(method)) return toolError("PROCESS_UNSUPPORTED: Engine does not advertise this process method");
    }
    const permission = await this.mutationPermission(gateway, method, params);
    if (permission instanceof Error) return toolError(permission.message);
    let reply: Record<string, unknown>;
    try { reply = await gateway.rpc(method, params, permission); }
    catch (cause) {
      if (method === "process.run") {
        try {
          const status = await gateway.status();
          if (status.status !== "ready" && this.owns(gateway)) await this.release();
        } catch { if (this.owns(gateway)) await this.release(); }
        return toolError(`${cause instanceof Error ? cause.message : "Launch outcome uncertain"}; launchId=${String(params.launchId)}. Query process.status with this launchId on the same session. If PROCESS_NOT_FOUND, retry only with the same launchId and identical parameters; never replay automatically.`);
      }
      throw cause;
    }
    if (reply.type === "error") {
      const code = typeof reply.error === "object" && reply.error !== null ? (reply.error as Record<string, unknown>).code : undefined;
      if (code === "SESSION_CLOSED") await this.release();
      if (method === "process.run" && code === "DEADLINE_EXCEEDED") return toolError(`DEADLINE_EXCEEDED; launchId=${String(params.launchId)}. Query process.status with this launchId on the same session. If PROCESS_NOT_FOUND, retry only with the same launchId and identical parameters; never replay automatically.`);
      return toolError(typeof code === "string" ? code : "Gateway RPC error");
    }
    return toolText(reply.result ?? reply);
  }

  private async mutationPermission(
    gateway: GatewayClient,
    method: string,
    params: Record<string, unknown>,
  ): Promise<{ grantId: string; kind?: "execute" | "control" } | undefined | Error> {
    if (method === "process.run" || method === "process.stop") {
      if (!gateway.processGrant) return new Error("PROCESS_UNSUPPORTED");
      try { return await gateway.processGrant(method === "process.run" ? { kind: "execute", workspace: params.workspace, script: params.script, launchId: params.launchId } : { kind: "control", processId: params.processId }); }
      catch (cause) { return new Error(cause instanceof Error ? cause.message : "Unable to obtain process grant"); }
    }
    if (method !== "fs.write" && method !== "fs.edit") return undefined;
    if (typeof params.workspace !== "string" || !params.workspace || typeof params.path !== "string" || !params.path) {
      return new Error(`${method} requires non-empty workspace and path for a Gateway grant`);
    }
    try {
      return await gateway.grant(params.workspace, params.path, method);
    } catch (cause) {
      return new Error(cause instanceof Error ? cause.message : "Unable to obtain Gateway mutation grant");
    }
  }

}
