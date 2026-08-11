import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createMcpBinding, McpBinding } from "nosrv/runtime/mcp";

test("MCP bindings initialize, call allowed tools, and preserve sessions", async () => {
  const methods: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    methods.push(message.method);
    response.setHeader("content-type", "application/json");
    response.setHeader("mcp-session-id", "test-session");
    if (message.method === "notifications/initialized") {
      response.statusCode = 202;
      response.end();
    } else if (message.method === "initialize") {
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { capabilities: {}, serverInfo: { name: "test", version: "1" } },
        }),
      );
    } else {
      assert.equal(request.headers["mcp-session-id"], "test-session");
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: message.params.arguments.query }] },
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    const binding = createMcpBinding({
      url: `http://127.0.0.1:${address.port}`,
      tools: ["search"],
    });
    const result = await binding("search", { query: "report" });
    assert.deepEqual(result.content, [{ type: "text", text: "report" }]);
    assert.deepEqual(methods, ["initialize", "notifications/initialized", "tools/call"]);
    await assert.rejects(binding("delete", {}), /not allowed/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("MCP bindings discover tool definitions", async () => {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.setHeader("content-type", "application/json");
    if (message.method === "notifications/initialized") {
      response.statusCode = 202;
      response.end();
    } else if (message.method === "initialize") {
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
    } else {
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: [
              {
                name: "search",
                description: "Search messages",
                inputSchema: {
                  type: "object",
                  properties: { query: { type: "string" } },
                  required: ["query"],
                },
              },
            ],
          },
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    const binding = new McpBinding({ url: `http://127.0.0.1:${address.port}`, tools: [] });
    assert.deepEqual(await binding.listTools(), [
      {
        name: "search",
        description: "Search messages",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
