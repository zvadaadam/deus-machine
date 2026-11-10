// backend/src/services/integrations/runtime.ts
// What a turn gets from Customize: the MCP servers of every enabled app that
// is ready. Every project and workspace inherits the same set; an app that
// is not ready is left out and never fails the turn.
//
// A turn start does no network work here. An app with an account is named by
// its gateway address (gateway.ts), which attaches the account's credential
// per request, so the config is the same from turn to turn and never holds a
// provider's token. Local servers and servers with no account are named
// directly.

import type { McpServerConfig } from "@zvada/agent-server/protocol";
import type { CatalogApp } from "@shared/integrations/types";
import { getErrorMessage } from "@shared/lib/errors";
import { cloudHolds } from "./auth/cloud-accounts";
import { findApp } from "./catalog";
import { credentialsFor } from "./credentials";
import { gatewayServer, usesGateway } from "./gateway";
import { getConnection, listInstallations, type InstallationRow } from "./store";

export interface TurnApps {
  servers: Record<string, McpServerConfig>;
  /** Installed apps left out of this turn, and why (logged, not fatal). */
  skipped: Array<{ appId: string; reason: string }>;
}

/** Names the engine and harnesses reserve for their own servers. */
const RESERVED = new Set(["deus", "codex_apps", "computer"]);

export function serverName(appId: string): string {
  const name = appId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return RESERVED.has(name) ? `app_${name}` : name;
}

/** The server a local turn names for one installed app, or why it has none. */
async function serverFor(
  app: CatalogApp,
  row: InstallationRow
): Promise<{ server: McpServerConfig } | { reason: string }> {
  const connection = row.connectionId ? getConnection(row.connectionId) : null;

  if (usesGateway(app)) {
    if (!connection || connection.status !== "active") {
      return { reason: connection?.status === "needs_reauth" ? "Sign in again" : "Not connected" };
    }
    // An account Deus Cloud holds works only while its Deus account is signed in.
    if (connection.kind === "managed" && !cloudHolds(connection)) {
      return { reason: "Sign in to your Deus account" };
    }
    const server = gatewayServer(app.id);
    return server ? { server } : { reason: "Deus is still starting" };
  }

  // A local server's variables: read from the vault, no network (every
  // remote account takes the gateway).
  const credentials = await credentialsFor(app, connection);
  if (!credentials.ok) return { reason: credentials.reason };

  return { server: { ...directServer(app, credentials), required: false } };
}

/**
 * An app's own server with what its account gives it: its variables in a
 * local server's environment, its headers on a remote one. What a turn names
 * for a local or open app, and what the gateway and the check connect to.
 */
export function directServer(
  app: CatalogApp,
  credentials: { headers: Record<string, string>; env: Record<string, string> }
): McpServerConfig {
  if (app.transport.type === "stdio") {
    const { env } = credentials;
    return {
      type: "stdio",
      command: app.transport.command,
      // `${NAME}` in an argument is one of the app's variables (some servers take keys as flags).
      args: app.transport.args.map((arg) =>
        arg.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (whole, name: string) => env[name] ?? whole)
      ),
      ...(Object.keys(env).length ? { env } : {}),
    };
  }
  if (app.transport.type === "broker") {
    // Reached through the gateway and Deus Cloud, never named directly.
    throw new Error(`${app.name} has no server of its own`);
  }
  return {
    type: app.transport.type,
    url: app.transport.url,
    ...(Object.keys(credentials.headers).length ? { headers: credentials.headers } : {}),
  };
}

/** The MCP servers a local turn carries. Never throws. */
export async function resolveTurnApps(): Promise<TurnApps> {
  const result: TurnApps = { servers: {}, skipped: [] };
  let rows: InstallationRow[];
  try {
    rows = listInstallations("app").filter((row) => row.enabled);
  } catch (error) {
    console.warn("[Integrations] Could not read installed apps:", getErrorMessage(error));
    return result;
  }
  await Promise.all(
    rows.map(async (row) => {
      const app = findApp(row.itemId);
      if (!app) {
        result.skipped.push({ appId: row.itemId, reason: "No longer in the catalog" });
        return;
      }
      try {
        const answer = await serverFor(app, row);
        if ("server" in answer) result.servers[serverName(app.id)] = answer.server;
        else result.skipped.push({ appId: app.id, reason: answer.reason });
      } catch (error) {
        result.skipped.push({ appId: app.id, reason: getErrorMessage(error) });
      }
    })
  );
  return result;
}
