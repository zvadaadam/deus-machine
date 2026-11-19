// agent-server/agents/deus-tools/index.ts
// Composes workspace + browser + recording + automation tools into the Deus MCP
// server. Agents drive a simulator with the agent-device CLI, which Deus ships
// and the turn's instructions brief them on, not with tools of Deus's own.

import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { trackedSessions } from "../../session-tracker";
import { createWorkspaceTools } from "./workspace";
import { createBrowserTools } from "./browser";
import { createAutomationTools } from "./automations";
import { createRecordingTools } from "./recording";

/**
 * The Deus MCP server for one chat. Claude runs it in process (`deus`, the
 * registry's `sdkMcpServers`); Codex reaches it over HTTP (`serveDeusTools`).
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

/**
 * Answer one MCP request for a chat's Deus tools, over Streamable HTTP. Each
 * request gets its own server and stateless transport (tools hold no state of
 * their own), and only a chat the engine has a turn for is served.
 */
export async function serveDeusTools(sessionId: string, request: Request): Promise<Response> {
  if (!trackedSessions.has(sessionId)) return new Response("Unknown chat", { status: 404 });
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await createDeusMCPServer(sessionId).instance.connect(transport);
  return transport.handleRequest(request);
}
