// sidecar/agents/hive-tools/index.ts
// Composes workspace + browser tools into the Hive MCP server.

import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { createWorkspaceTools } from "./workspace";
import { createBrowserTools } from "./browser";

/**
 * Creates and returns the Hive MCP server for a given session.
 * Uses the SDK's createSdkMcpServer to create a real McpServer instance
 * with proper .connect() support for the agent transport layer.
 *
 * The server is injected into the Claude Agent SDK via:
 *   sdkOptions.mcpServers = { hive: createHiveMCPServer(sessionId) }
 *
 * It is only enabled when `options.strictDataPrivacy` is false.
 */
export function createHiveMCPServer(sessionId: string) {
  return createSdkMcpServer({
    name: "hive",
    version: "1.0.0",
    tools: [...createWorkspaceTools(sessionId), ...createBrowserTools(sessionId)],
  });
}
