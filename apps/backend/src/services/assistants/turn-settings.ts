import { OperatorError, type StartInput } from "@zvada/agent-server/operator";
import { agentModels } from "@shared/api/settings";
import type { AgentHarness } from "@shared/enums";
import { HARNESSES } from "@shared/harnesses";
import {
  CATALOG_MODEL_LISTS,
  DEFAULT_THINKING_LEVEL,
  composerThinking,
  continuedThinkingLevel,
  findModel,
  latestTurnExecution,
  modelForSession,
} from "@shared/models";
import { readThinkingLevel, type ThinkingLevel } from "@shared/protocol";
import type { SessionTurn } from "@shared/types/session";
import { runAsThisComputer as run } from "../query-engine";
import { getSetting } from "../settings.service";

export interface TurnSettings {
  agentHarness: AgentHarness;
  model: string;
  thinkingLevel: ThinkingLevel;
}

/** Without a CLI answer the catalog can supply defaults. An explicit choice needs its check. */
export async function operatorModelLists(workspaceId?: string, checkChoice = false) {
  try {
    return (await run(agentModels, { workspaceId })).lists;
  } catch (error) {
    if (checkChoice) throw error;
    return CATALOG_MODEL_LISTS;
  }
}

/** Continue a recorded turn without querying a CLI. A fresh choice uses the workspace's list. */
export async function turnSettings(
  harness: AgentHarness,
  turns: readonly SessionTurn[],
  workspaceId?: string,
  start?: StartInput
): Promise<TurnSettings> {
  const latest = latestTurnExecution(harness, turns);
  const lists = latest
    ? []
    : await operatorModelLists(workspaceId, !!(start?.model || start?.thinkingLevel));
  const own = lists.find((list) => list.harness === harness);
  const model = start?.model ?? modelForSession(harness, turns, lists);
  if (!model) {
    const action = start ? "start_session" : "send_message";
    const reason = own?.error ? ` (${JSON.stringify(own.error)})` : "";
    throw new OperatorError(
      "unsupported",
      `${action}: ${harness} offered no models${reason}. Ask the person to install or sign in to the agent in Settings → AI. Nothing was ${start ? "started" : "sent"}.`
    );
  }

  const row = findModel(lists, harness, model)?.row;
  if (start?.model && !row)
    throw new OperatorError(
      "invalid_input",
      `start_session: model: ${JSON.stringify(model)} is not one ${harness} offers here; list_models names them. Nothing was started.`
    );
  const levels = own?.source === "live" ? row?.thinking.levels : undefined;
  const level = start?.thinkingLevel;
  if (
    level &&
    levels &&
    !levels.includes(level) &&
    !(level === "off" && HARNESSES[harness].acceptsUnlistedOff)
  )
    throw new OperatorError(
      "invalid_input",
      `start_session: thinking: ${JSON.stringify(level)} is not a level ${model} offers; ${levels.length ? `its levels are ${levels.map((l) => JSON.stringify(l)).join(", ")}` : "it has no thinking levels"}. Nothing was started.`
    );

  const fallback =
    readThinkingLevel(getSetting("default_thinking_level")) ?? DEFAULT_THINKING_LEVEL;
  return {
    agentHarness: harness,
    model,
    thinkingLevel:
      level ?? continuedThinkingLevel(latest) ?? composerThinking(fallback, levels, fallback),
  };
}
