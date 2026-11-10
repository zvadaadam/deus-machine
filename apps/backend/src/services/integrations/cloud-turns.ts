// backend/src/services/integrations/cloud-turns.ts
// What a cloud turn gets from Customize. Its options carry two complete
// sets: the MCP servers of the installed apps that reach the cloud, and the
// skills to place in the sandbox.
//
// An app reaches the cloud when Deus Cloud holds its account, or when it is
// a public remote server that needs none (`appReachesCloud`). The agent in
// the sandbox gets a capability for the first kind: it can call those apps'
// tools for a few hours and nothing else. The Deus session never goes to a
// sandbox, and neither does an account held on this computer.

import type { McpServerConfig } from "@zvada/agent-server/protocol";
import { appReachesCloud } from "@shared/integrations/compose";
import { getErrorMessage } from "@shared/lib/errors";
import { cloudHolds, cloudTurnServers } from "./auth/cloud-accounts";
import { findApp, findSkill } from "./catalog";
import { serverName } from "./runtime";
import { getConnection, listInstallations } from "./store";

/** A skill as a cloud turn carries it: the sandbox fetches the pinned folder itself. */
export interface TurnSkill {
  name: string;
  repo: string;
  ref: string;
  path: string;
}

/** The enabled, installed skills, pinned to the commit installed here. Never throws. */
function resolveTurnSkills(): TurnSkill[] {
  try {
    return listInstallations("skill").flatMap((row) => {
      if (!row.enabled || row.status !== "ready" || !row.installedRef) return [];
      const skill = findSkill(row.itemId);
      if (!skill) return [];
      return [
        {
          name: skill.name,
          repo: skill.source.repo,
          ref: row.installedRef,
          path: skill.source.path,
        },
      ];
    });
  } catch (error) {
    console.warn("[Integrations] Could not read installed skills:", getErrorMessage(error));
    return [];
  }
}

/**
 * Whether cloud turns carry the installed apps and skills
 * (`DEUS_CLOUD_EXTENSIONS=1`). Off until the platform this app talks to
 * accepts them: its parser refuses a turn with an option it does not know.
 */
export function cloudExtensionsEnabled(): boolean {
  return process.env.DEUS_CLOUD_EXTENSIONS === "1";
}

/** The MCP servers a cloud turn carries: every one optional. Never throws. */
async function resolveCloudTurnApps(): Promise<Record<string, McpServerConfig>> {
  const servers: Record<string, McpServerConfig> = {};
  const held: string[] = [];
  try {
    for (const row of listInstallations("app")) {
      const app = row.enabled ? findApp(row.itemId) : null;
      if (!app) continue;
      const connection = row.connectionId ? getConnection(row.connectionId) : null;
      if (!appReachesCloud(app, connection)) continue;
      if (connection?.kind === "managed") {
        if (cloudHolds(connection)) held.push(app.id);
      } else if (app.transport.type === "http") {
        servers[serverName(app.id)] = { type: "http", url: app.transport.url, required: false };
      }
    }
    // The agent in the sandbox gets a capability for these, never the Deus session.
    for (const [appId, server] of Object.entries(await cloudTurnServers(held))) {
      servers[serverName(appId)] = { ...server, required: false };
    }
  } catch (error) {
    // The turn goes on with what could be resolved.
    console.warn("[Integrations] A cloud turn starts without some apps:", getErrorMessage(error));
  }
  return servers;
}

/**
 * What a cloud turn adds to its options, both as the complete set: the MCP
 * servers of the installed apps that reach the cloud (an omitted map is an
 * empty one to the platform), and the skills to place in the sandbox, `[]`
 * included (an absent option leaves the sandbox's skills as they are).
 * Nothing while cloud extensions are off.
 */
export async function resolveCloudTurnExtensions(): Promise<{
  mcpServers?: Record<string, McpServerConfig>;
  skills?: TurnSkill[];
}> {
  if (!cloudExtensionsEnabled()) return {};
  const mcpServers = await resolveCloudTurnApps();
  return {
    ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
    skills: resolveTurnSkills(),
  };
}
