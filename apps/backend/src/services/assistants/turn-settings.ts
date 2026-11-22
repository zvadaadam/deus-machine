// backend/src/services/assistants/turn-settings.ts
// The settings an operator's first message or follow-up takes to the engine.

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
  defaultModelId,
  type HarnessModels,
} from "@shared/models";
import { readThinkingLevel, type ThinkingLevel } from "@shared/protocol";
import type { SessionTurn } from "@shared/types/session";
import { AgentServerDisconnectedError } from "../../lib/errors";
import { runAsThisComputer as run } from "../query-engine";
import { getSetting } from "../settings.service";

export interface TurnSettings {
  agentHarness: AgentHarness;
  model: string;
  thinkingLevel: ThinkingLevel;
}

function defaultThinking() {
  return readThinkingLevel(getSetting("default_thinking_level")) ?? DEFAULT_THINKING_LEVEL;
}

/** Only a choice the person left to Deus can come from the catalog while the engine is down. */
async function chooseModel(
  harness: AgentHarness,
  workspaceId: string | undefined,
  choice: Pick<StartInput, "model" | "thinkingLevel"> = {}
) {
  let lists: readonly HarnessModels[];
  try {
    lists = (await run(agentModels, { harness, workspaceId })).lists;
  } catch {
    if (choice.model || choice.thinkingLevel)
      throw new AgentServerDisconnectedError("The model could not be checked right now.");
    lists = CATALOG_MODEL_LISTS;
  }
  const own = lists.find((list) => list.harness === harness);
  const fallback = defaultModelId(lists, harness);
  if (!fallback) {
    const why = own?.error ? ` (${JSON.stringify(own.error)})` : "";
    return {
      reason: `${harness} offered no models${why}. Ask the person to install or sign in to the agent in Settings → AI.`,
    };
  }
  const model = choice.model ?? fallback;
  const row = findModel(lists, harness, model)?.row;
  const levels = own?.source === "live" ? row?.thinking.levels : undefined;
  return { model, row, levels };
}

export async function startSettings(
  harness: AgentHarness,
  input: StartInput
): Promise<TurnSettings> {
  const pick = await chooseModel(harness, input.workspace?.id, input);
  if (pick.reason !== undefined)
    throw new OperatorError("unsupported", `start_session: ${pick.reason} Nothing was started.`);
  const { model, row, levels } = pick;
  if (input.model && !row)
    throw new OperatorError(
      "invalid_input",
      `start_session: model: ${JSON.stringify(input.model)} is not one ${harness} offers here; list_models names them. Nothing was started.`
    );
  const level = input.thinkingLevel;
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
  const fallback = defaultThinking();
  return {
    agentHarness: harness,
    model,
    thinkingLevel: level ?? composerThinking(fallback, levels, fallback),
  };
}

export function continuedSettings(
  harness: AgentHarness,
  turns: readonly SessionTurn[]
): TurnSettings {
  const latest = latestTurnExecution(harness, turns);
  // A fresh chat takes the catalog default because a send cannot wait for the account default its composer shows.
  const model = latest?.model ?? defaultModelId(CATALOG_MODEL_LISTS, harness);
  if (!model)
    throw new OperatorError(
      "unsupported",
      `send_message: this chat has not run a turn yet. Ask the person to choose a model for ${HARNESSES[harness].label} in the chat, or use start_session with a model. Nothing was sent.`
    );
  return {
    agentHarness: harness,
    model,
    thinkingLevel: continuedThinkingLevel(latest) ?? defaultThinking(),
  };
}
