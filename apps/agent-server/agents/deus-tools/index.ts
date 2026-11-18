// agent-server/agents/deus-tools/index.ts
// Composes workspace + browser + recording + automation tools into the Deus MCP
// server. Agents drive a simulator with the agent-device CLI, which Deus ships
// and the turn's instructions brief them on, not with tools of Deus's own.

import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { createWorkspaceTools } from "./workspace";
import { createBrowserTools } from "./browser";
import { createAutomationTools } from "./automations";
import { createRecordingTools } from "./recording";

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
      ...createAutomationTools(sessionId),
      ...createRecordingTools(sessionId),
    ],
  });
}
