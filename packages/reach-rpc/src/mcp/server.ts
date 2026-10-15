import { createInterface } from "node:readline";
import type { ConnectorConfig, DeviceConfig } from "./config.js";
import { GatewayHttpError, HttpGatewayClient, SessionReplacedError, type GatewayClient, type ReadySession } from "./gateway.js";
import { deviceScopedTools, deviceTools, staticDeviceScopedTools } from "./tools.js";
import { MCP_VERSION } from "./version.js";

export { MCP_PROTOCOL_VERSION, type JsonRpcRequest } from "./protocol.js";
export { toolError, toolText } from "./result.js";
import { McpProtocol } from "./protocol.js";
import { GrantAwareInvoker } from "./invoker.js";
import { toolError, toolText } from "./result.js";
type Send = (message: Record<string, unknown>) => void;
type GatewayFactory = (device: DeviceConfig, config: ConnectorConfig) => GatewayClient;

interface SelectedDevice {
  device: DeviceConfig;
  gateway: GatewayClient;
  session: ReadySession;
  uncertain?: boolean;
}

export class McpServer {
  private readonly protocol: McpProtocol;
  private readonly invoker: GrantAwareInvoker;
  private pendingToolListChange = false;

  public constructor(
    protected readonly config: ConnectorConfig,
    protected readonly send: Send,
    private readonly gateways: GatewayFactory = (device, config) => new HttpGatewayClient(device, config.readyTimeoutMs, config.readyPollMs, fetch, config.requestTimeoutMs),
  ) {
    this.protocol = new McpProtocol(send, () => this.listTools(), params => this.callTool(params), () => this.flushToolListChange());
    this.invoker = new GrantAwareInvoker(() => this.releaseAfterFailure(), gateway => this.selected?.gateway === gateway);
  }

  protected selected: SelectedDevice | undefined;

  private gatewayFor(device: DeviceConfig): GatewayClient {
    const gateway = this.gateways(device, this.config);
    gateway.setClientLabel?.(`${this.protocol.clientLabel} (stdio)`);
    return gateway;
  }

  public async shutdown(): Promise<void> {
    const selected = this.selected;
    if (!selected) return;
    try {
      await selected.gateway.close();
      this.clearSelection();
    } catch (cause) {
      if (!await this.releaseAfterFailure()) throw cause;
    }
  }

  public receive(value: unknown): Promise<void> { return this.protocol.receive(value); }

  protected listTools(): readonly Record<string, unknown>[] {
    if (this.config.toolMode === "static") return [...deviceTools(), ...staticDeviceScopedTools()];
    return this.selected && !this.selected.uncertain ? [...deviceTools(), ...deviceScopedTools()] : deviceTools();
  }

  protected async callTool(params: unknown): Promise<Record<string, unknown>> {
    if (typeof params !== "object" || params === null) return toolError("tools/call params must be an object");
    const call = params as Record<string, unknown>;
    if (typeof call.name !== "string") return toolError("tools/call requires a tool name");
    switch (call.name) {
      case "list_devices":
        return toolText({ devices: this.config.devices.map(({ id }) => ({ id })) });
      case "get_versions":
        return this.getVersions(call.arguments);
      case "list_workspaces":
        return this.listWorkspaces(call.arguments);
      case "pick_device":
        return this.pickDevice(call.arguments);
      case "process.run":
      case "process.status":
      case "process.logs":
      case "process.stop":
      case "process.list":
      case "fs.read":
      case "fs.list":
      case "fs.glob":
      case "fs.stat":
      case "fs.grep":
      case "fs.write":
      case "fs.edit":
        return this.callDeviceToolForMode(call.name, call.arguments);
      case "session.close":
        return this.closeSessionForMode(call.arguments);
      default:
        return toolError(`Unknown tool: ${call.name}`);
    }
  }

  private async pickDevice(argumentsValue: unknown): Promise<Record<string, unknown>> {
    if (typeof argumentsValue !== "object" || argumentsValue === null || typeof (argumentsValue as Record<string, unknown>).deviceId !== "string") {
      return toolError("pick_device requires a string deviceId");
    }
    const selected = await this.selectDevice((argumentsValue as Record<string, unknown>).deviceId as string, this.config.toolMode === "dynamic");
    return selected instanceof Error ? toolError(selected.message) : toolText({ selectedDeviceId: selected.device.id, status: "ready" });
  }

  private async listWorkspaces(argumentsValue: unknown): Promise<Record<string, unknown>> {
    if (typeof argumentsValue !== "object" || argumentsValue === null || Array.isArray(argumentsValue) || !("deviceId" in argumentsValue) || typeof argumentsValue.deviceId !== "string") {
      return toolError("list_workspaces requires a string deviceId");
    }
    const selected = await this.selectDevice(argumentsValue.deviceId, this.config.toolMode === "dynamic");
    if (selected instanceof Error) return toolError(selected.message);
    if (selected.session.workspaces === undefined) return toolError("WORKSPACES_UNAVAILABLE: This Engine did not advertise workspace names");
    return toolText({
      deviceId: selected.device.id,
      status: "ready",
      workspaces: selected.session.workspaces,
      processWorkspaces: selected.session.processWorkspaces ?? [],
    });
  }

  private async getVersions(argumentsValue: unknown): Promise<Record<string, unknown>> {
    const args = argumentsValue ?? {};
    if (typeof args !== "object" || args === null || Array.isArray(args)) return toolError("Tool arguments must be an object");
    const deviceId = (args as Record<string, unknown>).deviceId;
    if (deviceId !== undefined && (typeof deviceId !== "string" || !deviceId)) return toolError("deviceId must be a non-empty string");
    const device = deviceId === undefined ? this.selected?.device : this.config.devices.find((candidate) => candidate.id === deviceId);
    if (deviceId !== undefined && !device) return toolError(`Unknown device: ${deviceId}`);
    try {
      const status = device ? await this.gatewayFor(device).status() : undefined;
      return toolText({
        mcpVersion: MCP_VERSION,
        ...(device ? { deviceId: device.id } : {}),
        gatewayVersion: status?.gatewayVersion ?? null,
        engineVersion: status?.engineVersion ?? null,
      });
    } catch (cause) {
      return toolError(cause instanceof Error ? cause.message : "Version query failed");
    }
  }

  private async callDeviceToolForMode(method: string, argumentsValue: unknown): Promise<Record<string, unknown>> {
    if (method.startsWith("process.") && method !== "process.run" && this.config.toolMode === "static") {
      if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) return toolError("INVALID_PARAMS: Tool arguments must be an object");
      const { deviceId, ...params } = argumentsValue as Record<string, unknown>;
      if (!this.selected || deviceId !== this.selected.device.id) return toolError("PROCESS_NOT_FOUND: No owned session for this task");
      return this.callDeviceTool(method, params);
    }
    const params = await this.argumentsForMode(argumentsValue);
    return params instanceof Error ? toolError(params.message) : this.callDeviceTool(method, params);
  }

  private async closeSessionForMode(argumentsValue: unknown): Promise<Record<string, unknown>> {
    if (this.config.toolMode === "static") {
      if (typeof argumentsValue !== "object" || argumentsValue === null || Array.isArray(argumentsValue)) return toolError("Tool arguments must be an object");
      const { deviceId } = argumentsValue as Record<string, unknown>;
      if (typeof deviceId !== "string" || !deviceId) return toolError("Static tool mode requires a string deviceId");
      if (!this.config.devices.some(device => device.id === deviceId)) return toolError(`Unknown device: ${deviceId}`);
      if (this.selected?.device.id !== deviceId) return toolText({ closedDeviceId: deviceId, closed: false, owned: false });
    }
    return this.closeSession();
  }

  private async argumentsForMode(argumentsValue: unknown): Promise<Record<string, unknown> | Error> {
    if (typeof argumentsValue !== "object" || argumentsValue === null || Array.isArray(argumentsValue)) {
      return new Error("Tool arguments must be an object");
    }
    const params = argumentsValue as Record<string, unknown>;
    if (this.config.toolMode !== "static") return params;
    if (typeof params.deviceId !== "string" || !params.deviceId) return new Error("Static tool mode requires a string deviceId");
    const selected = await this.selectDevice(params.deviceId, false);
    if (selected instanceof Error) return selected;
    const { deviceId: _deviceId, ...deviceScopedParams } = params;
    return deviceScopedParams;
  }

  private async selectDevice(deviceId: string, announce: boolean): Promise<SelectedDevice | Error> {
    const device = this.config.devices.find((candidate) => candidate.id === deviceId);
    if (!device) return new Error(`Unknown device: ${deviceId}`);
    try {
      const previous = this.selected;
      if (previous?.device.id === device.id && !previous.uncertain) {
        const status = await previous.gateway.status();
        if (status.status === "ready" && status.sessionId === previous.session.sessionId) {
          previous.session = status;
          return previous;
        }
      }
      if (previous) await previous.gateway.close();
      this.clearSelection();
      const gateway = this.gatewayFor(device);
      // Keep the client reachable even if opening or its cleanup fails.
      this.selected = { device, gateway, session: {}, uncertain: true };
      const session = await gateway.openAndWait();
      this.selected = { device, gateway, session };
      if (announce) this.pendingToolListChange = true;
      return this.selected;
    } catch (cause) {
      await this.releaseAfterFailure();
      return new Error(cause instanceof Error ? cause.message : "Unable to select device");
    }
  }

  protected async callDeviceTool(method: string, argumentsValue: unknown): Promise<Record<string, unknown>> {
    if (!this.selected) return toolError("Pick a ready device before using device-scoped tools");
    if (typeof argumentsValue !== "object" || argumentsValue === null || Array.isArray(argumentsValue)) {
      return toolError(`${method} arguments must be an object`);
    }
    try {
      const observing = method.startsWith("process.") && method !== "process.run";
      if (observing) {
        const status = await this.selected.gateway.status();
        if (status.status !== "ready" || status.sessionId !== this.selected.session.sessionId) return toolError("PROCESS_NOT_FOUND: Owner session is no longer active");
      }
      const selected = observing ? this.selected : await this.selectDevice(this.selected.device.id, this.config.toolMode === "dynamic");
      if (selected instanceof Error) return toolError(selected.message);
      await this.renewIfNeeded(selected);
      return await this.invoker.call(selected.gateway, method, argumentsValue as Record<string, unknown>);
    } catch (cause) {
      if (!(cause instanceof GatewayHttpError && cause.isRequestRejection)) await this.releaseAfterFailure();
      return toolError(cause instanceof Error ? cause.message : "Gateway tool call failed");
    }
  }

  private async closeSession(): Promise<Record<string, unknown>> {
    const selected = this.selected;
    if (!selected) return toolError("No selected device session to close");
    try {
      await selected.gateway.close();
      this.clearSelection();
      return toolText({ closedDeviceId: selected.device.id });
    } catch (cause) {
      if (cause instanceof SessionReplacedError) {
        this.clearSelection();
        return toolError("ENGINE_BUSY: selected session was replaced");
      }
      if (await this.releaseAfterFailure()) return toolText({ closedDeviceId: selected.device.id });
      return toolError(cause instanceof Error ? cause.message : "Unable to close selected device session");
    }
  }

  private async renewIfNeeded(selected: SelectedDevice): Promise<void> {
    const expiry = selected.session.leaseExpiresAt ? Date.parse(selected.session.leaseExpiresAt) : Number.NaN;
    if (!Number.isNaN(expiry) && expiry <= Date.now() + this.config.renewSkewMs) {
      selected.session = await selected.gateway.renew();
    }
  }

  private clearSelection(): void {
    if (this.selected && this.config.toolMode === "dynamic") this.pendingToolListChange = true;
    this.selected = undefined;
  }

  /** Hide stale tools, attempt a drain, and retain ownership if it still fails. */
  private async releaseAfterFailure(): Promise<boolean> {
    const selected = this.selected;
    if (!selected) return true;
    if (!selected.uncertain && this.config.toolMode === "dynamic") this.pendingToolListChange = true;
    selected.uncertain = true;
    try {
      await selected.gateway.close();
      this.clearSelection();
      return true;
    } catch (cause) {
      if (cause instanceof SessionReplacedError) {
        // Ownership is definitively gone; never drain the replacement.
        this.clearSelection();
        return true;
      }
      // The next selection must drain this client before opening a new one.
      return false;
    }
  }

  private flushToolListChange(): void {
    if (!this.pendingToolListChange) return;
    this.pendingToolListChange = false;
    this.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  }
}

/** Starts an MCP stdio server. Stdout carries JSON-RPC only; diagnostics use stderr. */
export function startStdioServer(config: ConnectorConfig): void {
  const server = new McpServer(config, (message) => process.stdout.write(`${JSON.stringify(message)}\n`));
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let pending = Promise.resolve();
  input.on("line", (line) => {
    pending = pending.then(async () => {
      try {
        await server.receive(JSON.parse(line) as unknown);
      } catch {
        await server.receive(undefined);
      }
    });
  });
  input.on("close", () => {
    pending = pending.then(() => server.shutdown()).catch((cause) => {
      process.stderr.write(`reach-mcp: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    });
  });
}
