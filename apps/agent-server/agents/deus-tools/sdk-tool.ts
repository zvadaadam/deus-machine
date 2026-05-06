import { tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";

type ToolHandler = (args: any, extra: unknown) => Promise<any>;

/**
 * Narrow wrapper around the Claude SDK's `tool()` helper.
 *
 * SDK 0.2.131 types MCP tool results more strictly than our in-process Deus
 * tools do. The runtime shape is still the SDK's expected MCP CallToolResult;
 * this keeps the local tool modules focused on behavior while preserving that
 * boundary cast in one place.
 */
export function tool(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  handler: ToolHandler,
  extras?: Parameters<typeof sdkTool>[4]
): SdkMcpToolDefinition<any> {
  return (sdkTool as any)(
    name,
    description,
    inputSchema,
    handler,
    extras
  ) as SdkMcpToolDefinition<any>;
}
