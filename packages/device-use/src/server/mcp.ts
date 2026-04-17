// MCP HTTP endpoint. In stateless mode, each request gets a fresh
// Server + Transport pair — per the SDK's guarantee that stateless
// transports can't be reused. We construct a tiny factory here.
//
// Every MCP tool call routes through invokeTool so the WS event bus sees
// it — same code path as REST and WebSocket invocations.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { invokeTool } from "./invoker.js";
import { TOOLS, type Context } from "./tools.js";

export function createMcpHandler(ctx: Context): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const server = new Server(
      { name: "device-use", version: "0.2.0" },
      { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: zodToJsonSchema(t.schema as any, { target: "jsonSchema7" }) as unknown as {
          type: "object";
        },
      })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (mcpReq) => {
      const result = await invokeTool(ctx, mcpReq.params.name, mcpReq.params.arguments ?? {});
      if (!result.success) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: result.error ?? "tool failed" }],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text:
              typeof result.result === "string"
                ? result.result
                : JSON.stringify(result.result, null, 2),
          },
        ],
        structuredContent:
          typeof result.result === "object" && result.result !== null
            ? (result.result as Record<string, unknown>)
            : undefined,
      };
    });

    const transport = new WebStandardStreamableHTTPServerTransport();
    await server.connect(transport);
    return transport.handleRequest(req);
    // Note: we deliberately do NOT close the server here — stateless
    // responses are still being written when handleRequest returns. The
    // server + transport become garbage collectable after the response
    // finishes streaming.
  };
}
