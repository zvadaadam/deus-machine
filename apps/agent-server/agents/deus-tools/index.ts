// agent-server/agents/deus-tools/index.ts
// Composes workspace + browser + simulator + recording tools into the Deus MCP server.
// The RecordingBridge snoops on browser tool executions to automatically emit
// recording events — the agent never needs to call recording_event manually.

import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { createWorkspaceTools } from "./workspace";
import { createBrowserTools } from "./browser";
import { createSimulatorTools } from "./simulator";
import { createRecordingTools, getSessionManager } from "./recording";
import { RecordingBridge } from "./recording-bridge";

/**
 * Creates and returns the Deus MCP server for a given session.
 * Uses the SDK's createSdkMcpServer to create a real McpServer instance
 * with proper .connect() support for the agent transport layer.
 *
 * The server is injected into the Claude Agent SDK via:
 *   sdkOptions.mcpServers = { deus: createDeusMCPServer(sessionId) }
 *
 * It is only enabled when `options.strictDataPrivacy` is false.
 *
 * Recording integration:
 *   - RecordingBridge is created and wired to browser tools via onAction callback
 *   - recording_start/stop tools call bridge.setActiveSession() to activate/deactivate
 *   - Browser tool executions automatically emit recording events via the bridge
 */
export function createDeusMCPServer(sessionId: string) {
  // Create the recording bridge that connects browser tools to the recording engine
  const bridge = new RecordingBridge(() => getSessionManager());

  // Create recording tools with bridge lifecycle hooks
  const recordingTools = createRecordingTools(sessionId);

  // Wrap recording_start and recording_stop to manage bridge state.
  // The tools array from createRecordingTools has start at [0] and stop at [1].
  const wrappedRecordingTools = recordingTools.map((toolDef) => {
    const originalHandler = toolDef.handler;
    if (toolDef.name === "recording_start") {
      toolDef.handler = async (args: any, extra: unknown) => {
        const result = await originalHandler(args, extra);
        // Extract sessionId from the response to activate the bridge
        try {
          const text = (result as any).content?.[0]?.text;
          if (text) {
            const parsed = JSON.parse(text);
            if (parsed.sessionId) {
              bridge.setActiveSession(parsed.sessionId);
            }
          }
        } catch {
          // Response parsing failed — bridge stays inactive
        }
        return result;
      };
    } else if (toolDef.name === "recording_stop") {
      toolDef.handler = async (args: any, extra: unknown) => {
        try {
          return await originalHandler(args, extra);
        } finally {
          bridge.setActiveSession(null);
        }
      };
    }
    return toolDef;
  });

  return createSdkMcpServer({
    name: "deus",
    version: "1.0.0",
    tools: [
      ...createWorkspaceTools(sessionId),
      ...createBrowserTools(sessionId, (action) => {
        bridge.onBrowserAction(action);
      }),
      ...createSimulatorTools(sessionId),
      ...wrappedRecordingTools,
    ],
  });
}
