import { createInterface } from "node:readline";
import type { ConnectorConfig } from "./config.js";

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

export class McpServer {
  private initialized = false;

  public constructor(
    protected readonly config: ConnectorConfig,
    private readonly send: Send,
  ) {}

  public async receive(value: unknown): Promise<void> {
    if (!isRequest(value)) {
      this.send(error(null, -32600, "Invalid Request"));
      return;
    }
    const isNotification = value.id === undefined;
    try {
      const result = await this.dispatch(value);
      if (!isNotification) this.send({ jsonrpc: "2.0", id: value.id ?? null, result });
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
    return [];
  }

  protected async callTool(_params: unknown): Promise<Record<string, unknown>> {
    return toolError("Unknown tool");
  }

  protected requireInitialized(): void {
    if (!this.initialized) throw new Error("MCP client must initialize before using tools");
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
