import { GatewayHttpError, SessionReplacedError } from "./gateway.js";
import { InProcessGatewayClient, type EngineApi } from "./in-process.js";
import { McpProtocol } from "./protocol.js";
import { GrantAwareInvoker } from "./invoker.js";
import { toolError, toolText } from "./result.js";
import { deviceTools, staticDeviceScopedTools } from "./tools.js";
import { MCP_VERSION } from "./version.js";

const METHODS: Record<string, string> = {
  process_run: "process.run", process_status: "process.status", process_logs: "process.logs", process_stop: "process.stop", process_list: "process.list",
  fs_read: "fs.read", fs_write: "fs.write", fs_edit: "fs.edit", fs_list: "fs.list",
  fs_glob: "fs.glob", fs_stat: "fs.stat", fs_grep: "fs.grep",
};

const EXPLANATIONS: Record<string, string> = {
  FILE_NOT_FOUND: "The path does not exist in this workspace.",
  REVISION_CONFLICT: "The file changed. Read it again and use the new revision as ifMatch.",
  SESSION_CLOSED: "The Engine session closed. Connect again before continuing.",
  DEADLINE_EXCEEDED: "The operation exceeded its time budget. Re-read the file before repeating a write.",
  PERMISSION_DENIED: "The workspace or path is not authorized for this operation.",
  INVALID_PARAMS: "Check the tool arguments and workspace-relative path. process_status requires exactly one of processId or launchId.",
  PROCESS_EXECUTION_DISABLED: "The Engine operator must enable execution for this workspace.",
  PROCESS_NOT_FOUND: "No task belongs to this session with that identity. After an uncertain launch, retry only with the same launchId and identical parameters.",
  LAUNCH_ID_CONFLICT: "This launchId already belongs to different parameters. Use its original parameters or a new launchId for a new task.",
  RUNTIME_UNAVAILABLE: "The fixed Engine Node runtime could not start. Inspect status by launchId; this failed identity remains reserved until the session ends.",
  PROCESS_LIMIT_EXCEEDED: "The Engine task or retained-record limit was reached.",
  PROCESS_UNSUPPORTED: "This Engine does not support managed Node processes.",
  PROCESS_CLEANUP_FAILED: "Process cleanup is incomplete; session ownership is retained.",
};

export class RemoteMcpServer {
  private readonly clients = new Map<string, InProcessGatewayClient>();
  private selectedId: string | undefined;
  public deadlineAt = 0;
  private readonly protocol: McpProtocol;
  private readonly invoker = new GrantAwareInvoker(async () => {}, () => false);
  public get initialized(): boolean { return this.protocol.acknowledged; }
  public receive(value: unknown): Promise<void> { return this.protocol.receive(value); }

  public constructor(private readonly engines: ReadonlyMap<string, EngineApi>, send: (message: Record<string, unknown>) => void, protocolVersion: string) {
    this.protocol = new McpProtocol(send, () => this.listTools(), params => this.callTool(params), undefined, {
      protocolVersion, listChanged: false, http: true,
      instructionsPrefix: "Use list_devices, then pick_device or a device tool with deviceId. If connecting, poll device_status after retryAfterMs. Read revision before overwrite/edit and pass ifMatch. After any write timeout, re-read before another write. Use process_status with the same launchId and owned session after an uncertain launch. Close owned sessions when finished. ",
    });
  }

  private listTools(): readonly Record<string, unknown>[] {
    const tools: Record<string, unknown>[] = [...deviceTools(), ...staticDeviceScopedTools()].map((tool) => ({ ...tool, name: (tool.name as string).replaceAll(".", "_") }));
    for (const tool of tools) {
      if (tool.name === "list_devices") tool.description = "List this Gateway's registered Reach Engine devices, last heartbeat times, and reported versions. A last reported version does not prove the device is online.";
      if (tool.name === "pick_device") tool.description = "Connect to a Reach Engine without waiting for it to wake up. When connecting, wait retryAfterMs and poll device_status. ENGINE_BUSY means another controller owns it.";

    }
    return [...tools, {
      name: "device_status", description: "Observe a device connection without opening or canceling its session. Poll after retryAfterMs when connecting.",
      inputSchema: { type: "object", properties: { deviceId: { type: "string" } }, required: ["deviceId"], additionalProperties: false },
    }];
  }

  private async callTool(params: unknown): Promise<Record<string, unknown>> {
    if (!params || typeof params !== "object" || Array.isArray(params)) return toolError("INVALID_PARAMS: tools/call params must be an object.");
    const call = params as Record<string, unknown>;
    if (typeof call.name !== "string") return toolError("INVALID_PARAMS: tools/call requires a tool name.");
    const method = Object.hasOwn(METHODS, call.name) ? METHODS[call.name] : undefined;
    if (call.name === "list_devices") return toolText({ devices: [...this.engines].map(([id, api]) => {
      const status = api.status();
      return { id, status: status.status, lastSeenAt: status.lastSeenAt ?? null, gatewayVersion: status.gatewayVersion ?? null, engineVersion: status.engineVersion ?? null };
    }) });
    const args = call.arguments ?? {};
    if (!args || typeof args !== "object" || Array.isArray(args)) return toolError("INVALID_PARAMS: Tool arguments must be an object.");
    const { deviceId, ...parameters } = args as Record<string, unknown>;
    if (call.name === "get_versions" && deviceId === undefined) {
      const status = this.selectedId ? this.engines.get(this.selectedId)?.status() : undefined;
      return toolText({ mcpVersion: MCP_VERSION, ...(this.selectedId ? { deviceId: this.selectedId } : {}), gatewayVersion: status?.gatewayVersion ?? null, engineVersion: status?.engineVersion ?? null });
    }
    if (!method && !["pick_device", "device_status", "session_close", "get_versions"].includes(call.name)) return toolError(`INVALID_PARAMS: Unknown tool: ${call.name}`);
    if (typeof deviceId !== "string" || !deviceId) return toolError("INVALID_PARAMS: A non-empty deviceId is required.");
    const api = this.engines.get(deviceId);
    if (!api) return toolError(`INVALID_PARAMS: Unknown device: ${deviceId}`);
    if (call.name === "get_versions") return toolText({ deviceId, mcpVersion: MCP_VERSION, gatewayVersion: api.status().gatewayVersion ?? null, engineVersion: api.status().engineVersion ?? null });
    if (call.name === "device_status") {
      const status = api.status();
      return toolText({ deviceId, status: status.status, owned: this.clients.get(deviceId)?.owns(status.sessionId) ?? false,
        ...(status.status === "ready" || status.status === "none" ? {} : { retryAfterMs: 1000 }) });
    }
    try {
      let client = this.clients.get(deviceId);
      if (call.name === "session_close") {
        if (!client && api.status().status !== "none") return toolError("ENGINE_BUSY: This MCP session does not own the Engine session; it was not closed.");
        const owned = client?.owns(api.status().sessionId) ?? false;
        if (client) { client.deadlineAt = this.deadlineAt; await client.close(); this.clients.delete(deviceId); }
        if (this.selectedId === deviceId) this.selectedId = undefined;
        return toolText({ closedDeviceId: deviceId, closed: owned, owned });
      }
      if (!client && method?.startsWith("process.") && method !== "process.run") return toolError("PROCESS_NOT_FOUND: No owned session for this task.");
      if (!client) { client = new InProcessGatewayClient(api); this.clients.set(deviceId, client); }
      client.deadlineAt = this.deadlineAt;
      const observing = method?.startsWith("process.") && method !== "process.run";
      if (observing && !client.owns(api.status().sessionId)) return toolError("PROCESS_NOT_FOUND: Owner session ended.");
      const status = observing ? await client.status() : await client.begin();
      if (call.name === "pick_device") this.selectedId = deviceId;
      if (status.status !== "ready") return toolText({ deviceId, status: "connecting", retryAfterMs: 1000 });
      if (call.name === "pick_device") return toolText({ selectedDeviceId: deviceId, status: "ready" });
      if (status.leaseExpiresAt && Date.parse(status.leaseExpiresAt) <= Date.now() + 60_000) await client.renew();
      const result = await this.invoker.call(client, method!, parameters);
      if (result.isError) {
        const content = result.content as Array<{ text: string }>;
        const code = content[0].text;
        if (Object.hasOwn(EXPLANATIONS, code)) content[0].text = `${code}: ${EXPLANATIONS[code]}`;
      }
      return result;
    } catch (cause) {
      if (cause instanceof SessionReplacedError) {
        this.clients.delete(deviceId);
        return toolError("ENGINE_BUSY: This Engine session belongs to another controller.");
      }
      if (cause instanceof GatewayHttpError && cause.path === "/session/open" && cause.status === 409) {
        this.clients.delete(deviceId);
        return toolError("ENGINE_BUSY: Another controller owns this Engine. Close its session and try again.");
      }
      return toolError(cause instanceof Error ? cause.message : "INTERNAL_ERROR: Engine operation failed.");
    }
  }

  public async shutdown(): Promise<void> {
    const failures: unknown[] = [];
    for (const [id, client] of this.clients) {
      client.deadlineAt = this.deadlineAt;
      try { await client.close(); this.clients.delete(id); }
      catch (cause) {
        if (cause instanceof SessionReplacedError) this.clients.delete(id);
        else failures.push(cause);
      }
    }
    if (failures.length) throw new AggregateError(failures, "Owned Engine sessions are still closing");
  }
}
