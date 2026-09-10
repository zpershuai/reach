import { createInterface } from "node:readline";
import type { ConnectorConfig, DeviceConfig } from "./config.js";
import { HttpGatewayClient, type GatewayClient, type ReadySession } from "./gateway.js";
import { deviceScopedTools, deviceTools } from "./tools.js";

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
    private readonly gateways: GatewayFactory = (device, config) => new HttpGatewayClient(device, config.readyTimeoutMs, config.readyPollMs),
  ) {}

  protected selected: SelectedDevice | undefined;

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
          serverInfo: { name: "reach-grok-bot-mcp", version: "0.1.0" },
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
    return this.selected ? [...deviceTools(), ...deviceScopedTools()] : deviceTools();
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
      default:
        return toolError(`Unknown tool: ${call.name}`);
    }
  }

  private async pickDevice(argumentsValue: unknown): Promise<Record<string, unknown>> {
    if (typeof argumentsValue !== "object" || argumentsValue === null || typeof (argumentsValue as Record<string, unknown>).deviceId !== "string") {
      return toolError("pick_device requires a string deviceId");
    }
    const deviceId = (argumentsValue as Record<string, unknown>).deviceId as string;
    const device = this.config.devices.find((candidate) => candidate.id === deviceId);
    if (!device) return toolError(`Unknown device: ${deviceId}`);
    const gateway = this.gateways(device, this.config);
    try {
      const session = await gateway.openAndWait();
      this.selected = { device, gateway, session };
      this.pendingToolListChange = true;
      return toolText({ selectedDeviceId: device.id, status: "ready" });
    } catch (cause) {
      this.selected = undefined;
      return toolError(cause instanceof Error ? cause.message : "Unable to select device");
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
}
