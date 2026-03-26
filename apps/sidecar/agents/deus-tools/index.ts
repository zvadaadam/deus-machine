// sidecar/agents/deus-tools/index.ts
// Composes workspace + browser tools into the Deus MCP server.

import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { createWorkspaceTools } from "./workspace";
import { createBrowserTools } from "./browser";
import { createSimulatorTools } from "./simulator";

/**
 * Creates and returns the Deus MCP server for a given session.
 * Uses the SDK's createSdkMcpServer to create a real McpServer instance
 * with proper .connect() support for the agent transport layer.
 *
 * The server is injected into the Claude Agent SDK via:
 *   sdkOptions.mcpServers = { deus: createDeusMCPServer(sessionId) }
 *
 * It is only enabled when `options.strictDataPrivacy` is false.
 */
export function createDeusMCPServer(sessionId: string) {
  return createSdkMcpServer({
    name: "deus",
    version: "1.0.0",
    tools: [
      ...createWorkspaceTools(sessionId),
      ...createBrowserTools(sessionId),
      ...createSimulatorTools(sessionId),
    ],
  });
}
