// apps/backend/src/services/aap/mcp-bridge.ts
//
// Single choke point for backend → agent-server coupling in AAP.
//
// When apps.service transitions a RunningAppEntry to "ready", it calls
// `registerMcpForRunningApp` here; we fire `aap/register-mcp` on the
// agent-client and the agent-server's registrar calls `setMcpServers`
// on every active Claude Query. Symmetrically, when an app stops/crashes,
// `unregisterMcpForRunningApp` fires `aap/unregister-mcp`.
//
// MCP registration is best-effort: if the agent-server isn't connected
// yet, we log a warning and return normally — the app is still running
// and the user can retry. We don't want a disconnected agent-server to
// rollback a successful launch.

import { idToServerName } from "@shared/aap/manifest";
import { getErrorMessage } from "@shared/lib/errors";

import { sendRequestToAgent, isConnected } from "../agent";

/** What the bridge needs to know about a running app to register its MCP.
 *  Kept separate from the internal RunningAppEntry so this file doesn't
 *  reach into apps.service internals — caller passes what it needs. */
export interface McpBridgeApp {
  appId: string;
  /** Fully-resolved MCP HTTP URL — `agent.tools.url` with `{port}` substituted. */
  mcpUrl: string;
}

/**
 * Register an app's MCP server with the agent-server. Best-effort — a
 * disconnected or throwing agent-server is logged and swallowed.
 */
export async function registerMcpForRunningApp(app: McpBridgeApp): Promise<void> {
  const serverName = idToServerName(app.appId);

  if (!isConnected()) {
    console.warn(
      `[AAP-Bridge] agent-server not connected — skipping register ${serverName}. MCP will not be registered for this app until the agent-server reconnects and a new session is spawned.`
    );
    return;
  }

  try {
    await sendRequestToAgent("aap/register-mcp", {
      serverName,
      url: app.mcpUrl,
    });
    console.log(`[AAP-Bridge] Registered ${serverName} → ${app.mcpUrl}`);
  } catch (err) {
    console.warn(`[AAP-Bridge] aap/register-mcp failed for ${serverName}: ${getErrorMessage(err)}`);
  }
}

/**
 * Unregister an app's MCP server from the agent-server. Best-effort — a
 * disconnected agent-server means the map gets cleaned up implicitly when
 * the next agent-server process starts with an empty map anyway.
 */
export async function unregisterMcpForRunningApp(app: McpBridgeApp): Promise<void> {
  const serverName = idToServerName(app.appId);

  if (!isConnected()) {
    console.warn(`[AAP-Bridge] agent-server not connected — skipping unregister ${serverName}.`);
    return;
  }

  try {
    await sendRequestToAgent("aap/unregister-mcp", { serverName });
    console.log(`[AAP-Bridge] Unregistered ${serverName}`);
  } catch (err) {
    console.warn(
      `[AAP-Bridge] aap/unregister-mcp failed for ${serverName}: ${getErrorMessage(err)}`
    );
  }
}
