import { createInterface } from "node:readline";
import type { ConnectorConfig, DeviceConfig } from "./config.js";
import { GatewayHttpError, HttpGatewayClient, SessionReplacedError, type GatewayClient, type ReadySession } from "./gateway.js";
import { deviceScopedTools, deviceTools, staticDeviceScopedTools } from "./tools.js";

export const MCP_PROTOCOL_VERSION = "2025-03-26";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

type JsonRpcId = string | number | null;
type Send = (message: Record<string, unknown>) => void;
type GatewayFactory = (device: DeviceConfig, config: ConnectorConfig) => GatewayClient;

interface SelectedDevice {
  device: DeviceConfig;
  gateway: GatewayClient;
  session: ReadySession;
  uncertain?: boolean;
}

function isRequest(value: unknown): value is JsonRpcRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Record<string, unknown>;
  return request.jsonrpc === "2.0" && typeof request.method === "string";
}

function error(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export class McpServer {
  private initialized = false;
  private pendingToolListChange = false;

  public constructor(
    protected readonly config: ConnectorConfig,
    protected readonly send: Send,
    private readonly gateways: GatewayFactory = (device, config) => new HttpGatewayClient(device, config.readyTimeoutMs, config.readyPollMs, fetch, config.requestTimeoutMs),
  ) {}

  protected selected: SelectedDevice | undefined;

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

  public async receive(value: unknown): Promise<void> {
    if (!isRequest(value)) {
      this.send(error(null, -32600, "Invalid Request"));
      return;
    }
    const isNotification = value.id === undefined;
    try {
      const result = await this.dispatch(value);
      if (!isNotification) {
        this.send({ jsonrpc: "2.0", id: value.id ?? null, result });
        this.flushToolListChange();
      }
    } catch (cause) {
      if (!isNotification) {
        this.send(error(value.id ?? null, -32603, cause instanceof Error ? cause.message : "Internal error"));
      }
    }
  }

  protected async dispatch(request: JsonRpcRequest): Promise<Record<string, unknown>> {
    switch (request.method) {
      case "initialize":
        this.initialized = true;
        return {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "reach-mcp", version: "0.1.0" },
        };
      case "notifications/initialized":
        return {};
      case "tools/list":
        this.requireInitialized();
        return { tools: this.listTools() };
      case "tools/call":
        this.requireInitialized();
        return this.callTool(request.params);
      default:
        throw new Error(`Method not found: ${request.method}`);
    }
  }

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
      case "pick_device":
        return this.pickDevice(call.arguments);
      case "fs.read":
      case "fs.list":
      case "fs.glob":
      case "fs.stat":
      case "fs.grep":
      case "fs.write":
      case "fs.edit":
        return this.callFilesystemForMode(call.name, call.arguments);
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

  private async callFilesystemForMode(method: string, argumentsValue: unknown): Promise<Record<string, unknown>> {
    const params = await this.argumentsForMode(argumentsValue);
    return params instanceof Error ? toolError(params.message) : this.callFilesystem(method, params);
  }

  private async closeSessionForMode(argumentsValue: unknown): Promise<Record<string, unknown>> {
    if (this.config.toolMode === "static") {
      const params = await this.argumentsForMode(argumentsValue);
      if (params instanceof Error) return toolError(params.message);
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
      const gateway = this.gateways(device, this.config);
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

  protected async callFilesystem(method: string, argumentsValue: unknown): Promise<Record<string, unknown>> {
    if (!this.selected) return toolError("Pick a ready device before using filesystem tools");
    if (typeof argumentsValue !== "object" || argumentsValue === null || Array.isArray(argumentsValue)) {
      return toolError(`${method} arguments must be an object`);
    }
    const selected = await this.selectDevice(this.selected.device.id, this.config.toolMode === "dynamic");
    if (selected instanceof Error) return toolError(selected.message);
    try {
      await this.renewIfNeeded(selected);
      const params = argumentsValue as Record<string, unknown>;
      const permission = await this.mutationPermission(selected.gateway, method, params);
      if (permission instanceof Error) return toolError(permission.message);
      const reply = await selected.gateway.rpc(method, params, permission);
      if (reply.type === "error") {
        const candidate = typeof reply.error === "object" && reply.error !== null ? (reply.error as Record<string, unknown>).code : undefined;
        const code = typeof candidate === "string" ? candidate : "Gateway RPC error";
        if (code === "SESSION_CLOSED") await this.releaseAfterFailure();
        return toolError(code);
      }
      return toolText(reply.result ?? reply);
    } catch (cause) {
      if (!(cause instanceof GatewayHttpError && cause.isRequestRejection)) await this.releaseAfterFailure();
      return toolError(cause instanceof Error ? cause.message : "Gateway filesystem call failed");
    }
  }

  private async mutationPermission(
    gateway: GatewayClient,
    method: string,
    params: Record<string, unknown>,
  ): Promise<{ grantId: string } | undefined | Error> {
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

  private async closeSession(): Promise<Record<string, unknown>> {
    const selected = this.selected;
    if (!selected) return toolError("No selected device session to close");
    try {
      await selected.gateway.close();
      this.clearSelection();
      return toolText({ closedDeviceId: selected.device.id });
    } catch (cause) {
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

  protected requireInitialized(): void {
    if (!this.initialized) throw new Error("MCP client must initialize before using tools");
  }

  private flushToolListChange(): void {
    if (!this.pendingToolListChange) return;
    this.pendingToolListChange = false;
    this.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  }
}

export function toolText(value: unknown): Record<string, unknown> {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: "text", text: message }], isError: true };
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
