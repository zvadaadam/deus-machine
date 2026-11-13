/** Answers the operations in `shared/api/settings.ts`. */

import { existsSync } from "node:fs";
import { match } from "ts-pattern";
import * as api from "@shared/api/settings";
import type { ParsedInputOf } from "@shared/api/op";
import type { AgentAuthAnswer } from "@shared/agent-auth";
import type { AgentConfigBySection, AgentConfigSection } from "@shared/types/agent-config";
import { getWorkspaceForMiddleware } from "../db";
import { getDatabase } from "../lib/database";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { invalidateRemoteGateCache } from "../middleware/remote-gate";
import { computeWorkspacePath } from "../middleware/workspace-loader";
import { getLocalAgents } from "../services/agent";
import { getCloudModelLists } from "../services/agent/cloud/models";
import {
  deleteAgent,
  deleteCommand,
  deleteSkill,
  getAgents,
  getCommands,
  getHooks,
  getMcpServers,
  getSkills,
  saveAgent,
  saveCommand,
  saveHooks,
  saveMcpServers,
  saveSkill,
} from "../services/agent-config.service";
import { syncKeepAwake } from "../services/keep-awake.service";
import { reconcileRelay } from "../services/relay.service";
import { getAllSettings, PRIVATE_SETTINGS, saveSetting } from "../services/settings.service";
import { disconnectDirectDevices } from "../services/ws.service";
import { handle } from "./registry";

/**
 * Store one preference and do what follows from it. Also what `POST /settings`
 * runs: the remote-access test stack turns remote access on and off over HTTP.
 */
export function writeSetting(key: string, value: unknown): void {
  if (PRIVATE_SETTINGS.has(key)) throw new ValidationError(`${key} is not a setting`);
  saveSetting(key, value);

  if (key === "remote_access_enabled") {
    // The gate refuses the local network from now on, not in five seconds.
    invalidateRemoteGateCache();
    // Turning it on is also how a computer removed from the account is added again.
    reconcileRelay({ restart: value === true });
    if (value !== true) disconnectDirectDevices();
  }
  if (key === "remote_access_enabled" || key === "remote_keep_awake") syncKeepAwake();
}

/** The project's folder for `project` scope; undefined for this computer's own `~/.claude`. */
function projectPathOf(input: { scope: "global" | "project"; repoPath?: string }) {
  if (input.scope === "global") return undefined;
  if (!input.repoPath) throw new ValidationError("repoPath is required for project scope");
  return input.repoPath;
}

const readSection: {
  [Section in AgentConfigSection]: (projectPath?: string) => AgentConfigBySection[Section];
} = {
  "mcp-servers": getMcpServers,
  commands: getCommands,
  agents: getAgents,
  hooks: getHooks,
  skills: getSkills,
};

const deleteItem = {
  commands: { run: deleteCommand, label: "Command" },
  agents: { run: deleteAgent, label: "Agent" },
  skills: { run: deleteSkill, label: "Skill" },
};

function saveAgentConfig(input: ParsedInputOf<typeof api.saveAgentConfig>): void {
  const projectPath = projectPathOf(input);
  match(input)
    .with({ section: "mcp-servers" }, ({ servers }) => saveMcpServers(servers, projectPath))
    .with({ section: "commands" }, ({ name, content }) => saveCommand(name, content, projectPath))
    .with({ section: "agents" }, ({ id, name, description, tools }) =>
      saveAgent(id, { name, description, tools }, projectPath)
    )
    .with({ section: "hooks" }, ({ hooks }) => saveHooks(hooks, projectPath))
    .with({ section: "skills" }, ({ name, content }) => saveSkill(name, content, projectPath))
    .exhaustive();
}

/** Each local agent's CLI and login. Also what `deus status` reads at `GET /settings/agent-auth`. */
export async function readAgentAuth(): Promise<AgentAuthAnswer> {
  try {
    return await getLocalAgents().status();
  } catch (error) {
    // An engine that cannot be asked is an answer the page shows (with a retry), not a failed read.
    return {
      auth: [],
      clis: [],
      logins: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export default [
  handle(api.settings, () => getAllSettings()),
  handle(api.saveSetting, ({ key, value }) => writeSetting(key, value)),

  handle(api.agentConfig, (input) => readSection[input.section](projectPathOf(input))),
  handle(api.saveAgentConfig, saveAgentConfig),
  handle(api.deleteAgentConfig, (input) => {
    const projectPath = projectPathOf(input);
    const { run, label } = deleteItem[input.section];
    if (!run(input.itemId, projectPath)) {
      throw new NotFoundError(`${label} '${input.itemId}' not found`);
    }
  }),

  handle(api.agentAuth, readAgentAuth),
  handle(api.agentModels, async ({ workspaceId }) => {
    const workspace = workspaceId
      ? getWorkspaceForMiddleware(getDatabase(), workspaceId)
      : undefined;
    const folder = workspace ? computeWorkspacePath(workspace) : "";
    // A cloud workspace, or one whose folder is gone, is asked for with no folder.
    return {
      lists: await getLocalAgents().models(folder && existsSync(folder) ? folder : undefined),
    };
  }),
  handle(api.cloudModels, async () => {
    const lists = await getCloudModelLists().catch((error: unknown) => {
      // The platform being unreachable is not a backend fault: say what failed.
      throw new AppError(502, error instanceof Error ? error.message : String(error));
    });
    return lists ? { configured: true, lists } : { configured: false, lists: [] };
  }),

  handle(api.agentPrepareClis, () => getLocalAgents().prepareClis()),
  handle(api.agentSignIn, ({ harness, method, apiKey }) =>
    getLocalAgents().signIn(harness, method, apiKey?.trim() || undefined)
  ),
  handle(api.agentLoginCode, async ({ loginId, code }) => ({
    auth: await getLocalAgents().complete(loginId, code),
  })),
  handle(api.agentLoginCancel, ({ loginId }) => getLocalAgents().cancel(loginId)),
  handle(api.agentLogout, async ({ harness }) => ({
    auth: await getLocalAgents().logout(harness),
  })),
];
