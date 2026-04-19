// agent-server/agents/deus-tools/apps.ts
//
// AAP lifecycle tools surfaced in the Deus MCP server. Thin wrappers: each
// tool validates its args, calls `EventBroadcaster.requestXxx(...)` to hit
// the backend's apps.service (where real state + process management lives),
// and formats the result for the agent.
//
// The backend is the single writer for AAP state. These tools never touch
// the registrar directly — when a launch succeeds, the backend's mcp-bridge
// fires `aap/register-mcp` back to the agent-server, which the registrar
// handles separately. Two clean halves, one choke point per direction.

import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getErrorMessage } from "@shared/lib/errors";
import { EventBroadcaster } from "../../event-broadcaster";

// ----------------------------------------------------------------------------
// Response helpers
// ----------------------------------------------------------------------------

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * Wrap a tool handler with error catching. Returns error text instead of
 * throwing — same pattern as browser/simulator tools. An exception escaping
 * a tool handler would break the ongoing agent turn.
 */
function withErrorCatch<T>(
  fn: (args: T) => Promise<{ content: Array<{ type: string; [k: string]: unknown }> }>
) {
  return async (args: T) => {
    try {
      return await fn(args);
    } catch (err) {
      return textResult(`AAP error: ${getErrorMessage(err)}`);
    }
  };
}

// ----------------------------------------------------------------------------
// Factory
// ----------------------------------------------------------------------------

export function createAppsTools(sessionId: string): SdkMcpToolDefinition<any>[] {
  return [
    // -- ListApps -------------------------------------------------------------
    tool(
      "list_apps",
      `List installed Deus apps and which are currently running in YOUR workspace.

Returns a JSON object:
  { apps: InstalledApp[], runningAppIds: string[] }
Each app has { id, name, description, version, icon?, bootstrap? }.
Use the app's \`id\` (e.g. "deus.mobile-use") as the argument to launch_app.

Running apps are auto-scoped to the agent's current session/workspace;
you don't need (and can't pass) a workspaceId.`,
      {},
      withErrorCatch(async () => {
        console.log(`[deusMCPServer] list_apps invoked for session ${sessionId}`);
        const response = await EventBroadcaster.requestListApps({ sessionId });
        return textResult(JSON.stringify(response, null, 2));
      })
    ),

    // -- LaunchApp ------------------------------------------------------------
    tool(
      "launch_app",
      `Launch an installed Deus app in YOUR current workspace. The backend
spawns the app's subprocess, waits for its ready probe, and (on success)
registers its MCP tools into THIS agent session. New tools appear as
\`mcp__{app_server_name}__*\` (e.g. \`mcp__deus_mobile_use__snapshot\` for
the mobile-use app) within a few seconds — they're immediately callable.

One instance per (appId, workspace): a duplicate launch returns the
existing runningAppId. The app's manifest \`bootstrap\` — a short help
string — is returned so you know how to use its tools.

Workspace is inferred from your session — do NOT pass a workspaceId.`,
      {
        appId: z.string().describe('App id (e.g. "deus.mobile-use"). Get from list_apps.'),
      },
      withErrorCatch(async (args: { appId: string }) => {
        console.log(
          `[deusMCPServer] launch_app invoked for session ${sessionId} appId=${args.appId}`
        );
        const response = await EventBroadcaster.requestLaunchApp({
          appId: args.appId,
          sessionId,
        });

        const lines = [
          `Launched ${args.appId}`,
          `  runningAppId: ${response.runningAppId}`,
          `  url: ${response.url}`,
        ];
        if (response.bootstrap) {
          lines.push("", `App bootstrap hint:`, response.bootstrap);
        }
        lines.push(
          "",
          `The app's MCP tools (mcp__{server}__*) will appear in your tool list shortly.`
        );
        return textResult(lines.join("\n"));
      })
    ),

    // -- StopApp --------------------------------------------------------------
    tool(
      "stop_app",
      `Stop a running Deus app by its runningAppId. The backend sends SIGTERM,
waits for the stop timeout, then SIGKILLs if needed. The app's MCP tools
are automatically removed from your tool list.`,
      {
        runningAppId: z.string().describe("The runningAppId returned by launch_app."),
      },
      withErrorCatch(async (args: { runningAppId: string }) => {
        console.log(
          `[deusMCPServer] stop_app invoked for session ${sessionId} runningAppId=${args.runningAppId}`
        );
        const response = await EventBroadcaster.requestStopApp({
          runningAppId: args.runningAppId,
        });
        return textResult(
          response.success
            ? `Stopped runningAppId ${args.runningAppId}.`
            : `Failed to stop runningAppId ${args.runningAppId}.`
        );
      })
    ),

    // -- ReadAppSkill ---------------------------------------------------------
    tool(
      "read_app_skill",
      `Read the detailed usage docs ("skill") an installed Deus app ships with.
The \`launch_app\` tool deliberately keeps its response lean — call this
only when you need deeper guidance on how to drive the app's MCP tools
(typical triggers: first use of an app in a session, or unfamiliar tool
names showing up after a launch). Content is markdown; may include
command examples, workflow patterns, and JSON shape references.

Returns an empty string if the app declares no skills.`,
      {
        appId: z.string().describe('App id (e.g. "deus.mobile-use"). Get from list_apps.'),
      },
      withErrorCatch(async (args: { appId: string }) => {
        console.log(
          `[deusMCPServer] read_app_skill invoked for session ${sessionId} appId=${args.appId}`
        );
        const response = await EventBroadcaster.requestReadAppSkill({ appId: args.appId });
        return textResult(
          response.content.length > 0 ? response.content : `No skills declared for ${args.appId}.`
        );
      })
    ),
  ];
}
