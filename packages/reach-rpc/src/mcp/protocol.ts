import { MCP_VERSION } from "./version.js";
export const MCP_PROTOCOL_VERSION = "2025-03-26";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

type JsonRpcId = string | number | null;
type Send = (message: Record<string, unknown>) => void;
function isRequest(value: unknown): value is JsonRpcRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Record<string, unknown>;
  return request.jsonrpc === "2.0" && typeof request.method === "string";
}

function error(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

interface ProtocolOptions {
  protocolVersion?: string;
  listChanged?: boolean;
  instructionsPrefix?: string;
  http?: boolean;
}
export class McpProtocol {
  private initialized = false;
  public acknowledged = false;
  constructor(
    private readonly send: Send,
    private readonly tools: () => readonly Record<string, unknown>[],
    private readonly call: (params: unknown) => Promise<Record<string, unknown>>,
    private readonly afterReply: () => void = () => {},
    private readonly options: ProtocolOptions = {},
  ) {}
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
        this.afterReply();
      }
    } catch (cause) {
      if (!isNotification) {
        this.send(error(value.id ?? null, this.errorCode(cause), cause instanceof Error ? cause.message : "Internal error"));
      }
    }
  }

  private errorCode(cause: unknown): number {
    return this.options.http && cause instanceof Error && cause.message.startsWith("Method not found:") ? -32601 : -32603;
  }

  protected async dispatch(request: JsonRpcRequest): Promise<Record<string, unknown>> {
    switch (request.method) {
      case "initialize":
        this.initialized = true;
        return {
          protocolVersion: this.options.protocolVersion ?? MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: this.options.listChanged ?? true } },
          serverInfo: { name: "reach-mcp", version: MCP_VERSION },
          instructions: ((this.options.instructionsPrefix ?? "") + "Reach Engine installation automatically provisions a private Node.js runtime at ~/.reach/runtime/node/bin/node for Gateway and MCP processes on the same host. Launch those processes with that executable or the installed run-node.sh launcher. Engine uses this private runtime for trusted workspace scripts when execution is locally enabled. Scripts run with the Engine account privileges and are stopped when their owner session ends. Supply a unique launchId and recover uncertain launches with process.status on the same session. Filesystem tools execute on the selected Engine through its Gateway.").replaceAll("process.status", this.options.http ? "process_status" : "process.status"),
        };
      case "notifications/initialized":
        this.acknowledged = true;
        return {};
      case "ping":
        if (this.options.http) return {};
        throw new Error(`Method not found: ${request.method}`);
      case "tools/list":
        this.requireInitialized();
        return { tools: this.tools() };
      case "tools/call":
        this.requireInitialized();
        return this.call(request.params);
      default:
        throw new Error(`Method not found: ${request.method}`);
    }
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error("MCP client must initialize before using tools");
  }
}
