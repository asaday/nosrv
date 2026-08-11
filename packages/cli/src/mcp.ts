import type { Binding, BindingCallResult } from "@nosrv/core";

export interface McpBindingOptions {
  url: string;
  tools: readonly string[];
  headers?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Readonly<Record<string, unknown>>;
}

export class McpBinding implements Binding {
  readonly #options: McpBindingOptions;
  #sessionId?: string;
  #initialized?: Promise<void>;
  #requestId = 0;

  constructor(options: McpBindingOptions) {
    this.#options = options;
  }

  async #rpc(method: string, params: unknown, notification = false): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#options.timeoutMs ?? 15_000);
    try {
      const response = await fetch(this.#options.url, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          ...this.#options.headers,
          ...(this.#sessionId ? { "mcp-session-id": this.#sessionId } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          ...(!notification ? { id: ++this.#requestId } : {}),
          method,
          params,
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`MCP ${method} failed with HTTP ${response.status}`);
      this.#sessionId = response.headers.get("mcp-session-id") ?? this.#sessionId;
      if (notification || response.status === 202) return undefined;
      const contentType = response.headers.get("content-type") ?? "";
      let message: Record<string, unknown>;
      if (contentType.includes("application/json")) {
        message = (await response.json()) as Record<string, unknown>;
      } else if (contentType.includes("text/event-stream")) {
        const data = (await response.text())
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .find((line) => line && line !== "[DONE]");
        if (!data) throw new Error(`MCP ${method} returned an empty event stream`);
        message = JSON.parse(data) as Record<string, unknown>;
      } else {
        throw new Error(`MCP ${method} returned unsupported content type: ${contentType}`);
      }
      if (message.error) {
        const detail = message.error as Record<string, unknown>;
        throw new Error(`MCP ${method} failed: ${String(detail.message ?? "Unknown error")}`);
      }
      return message.result;
    } finally {
      clearTimeout(timeout);
    }
  }

  async #initialize(): Promise<void> {
    this.#initialized ??= (async () => {
      await this.#rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "nosrv", version: "0.2.0" },
      });
      await this.#rpc("notifications/initialized", {}, true);
    })();
    return this.#initialized;
  }

  async call(
    tool: string,
    arguments_: Readonly<Record<string, unknown>> = {},
  ): Promise<BindingCallResult> {
    if (!this.#options.tools.includes(tool)) throw new Error(`MCP tool is not allowed: ${tool}`);
    await this.#initialize();
    const result = (await this.#rpc("tools/call", { name: tool, arguments: arguments_ })) as
      BindingCallResult | undefined;
    if (!result || !Array.isArray(result.content)) throw new Error("Invalid MCP tools/call result");
    return result;
  }

  async listTools(): Promise<McpToolDefinition[]> {
    await this.#initialize();
    const tools: McpToolDefinition[] = [];
    let cursor: string | undefined;
    do {
      const result = (await this.#rpc("tools/list", cursor ? { cursor } : {})) as
        { tools?: unknown; nextCursor?: unknown } | undefined;
      if (!result || !Array.isArray(result.tools)) throw new Error("Invalid MCP tools/list result");
      tools.push(...result.tools.map(mcpToolDefinition));
      if (tools.length > 500) throw new Error("MCP tools/list returned too many tools");
      if (result.nextCursor !== undefined && typeof result.nextCursor !== "string") {
        throw new Error("Invalid MCP tools/list cursor");
      }
      cursor = result.nextCursor || undefined;
    } while (cursor);
    return tools;
  }
}

function mcpToolDefinition(value: unknown): McpToolDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid MCP tool definition");
  }
  const tool = value as Record<string, unknown>;
  if (typeof tool.name !== "string" || !tool.name) throw new Error("Invalid MCP tool name");
  if (
    !tool.inputSchema ||
    typeof tool.inputSchema !== "object" ||
    Array.isArray(tool.inputSchema)
  ) {
    throw new Error(`Invalid MCP input schema for tool: ${tool.name}`);
  }
  if (tool.description !== undefined && typeof tool.description !== "string") {
    throw new Error(`Invalid MCP tool description: ${tool.name}`);
  }
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema as Record<string, unknown>,
  };
}
