// backend/src/services/assistants/turn-settings.ts
// The settings an operator's first message or follow-up takes to the engine.

import { OperatorError, type StartInput } from "@zvada/agent-server/operator";
import { agentModels } from "@shared/api/settings";
import type { AgentHarness } from "@shared/enums";
import { HARNESSES } from "@shared/harnesses";
import {
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

/**
 * An operator message runs on the chat's own agent with plan mode off. A start can
 * name its model and thinking level. Otherwise the latest turn on that agent
 * supplies them. With no recorded model, take the default from that agent's list
 * for this workspace and fit the person's default thinking level to its live row.
 */
async function resolveSettings(
  tool: "start_session" | "send_message",
  harness: AgentHarness,
  turns: readonly SessionTurn[],
  workspaceId: string | undefined,
  choice: Pick<StartInput, "model" | "thinkingLevel"> = {}
) {
  const latest = latestTurnExecution(harness, turns);
  const lists = latest ? [] : (await run(agentModels, { harness, workspaceId })).lists;
  const own = lists.find((list) => list.harness === harness);
  const model = choice.model ?? modelForSession(harness, turns, lists);
  if (!model) {
    const reason = own?.error ? ` (${JSON.stringify(own.error)})` : "";
    const refused = tool === "start_session" ? "Nothing was started." : "Nothing was sent.";
    throw new OperatorError(
      "unsupported",
      `${tool}: ${harness} offered no models${reason}. Ask the person to install or sign in to the agent in Settings → AI. ${refused}`
    );
  }

  const row = findModel(lists, harness, model)?.row;
  const levels = own?.source === "live" ? row?.thinking.levels : undefined;
  const fallback =
    readThinkingLevel(getSetting("default_thinking_level")) ?? DEFAULT_THINKING_LEVEL;
  const settings: TurnSettings = {
    agentHarness: harness,
    model,
    thinkingLevel:
      choice.thinkingLevel ??
      continuedThinkingLevel(latest) ??
      composerThinking(fallback, levels, fallback),
  };
  return { settings, row, levels };
}

export async function startSettings(
  harness: AgentHarness,
  input: StartInput
): Promise<TurnSettings> {
  const { settings, row, levels } = await resolveSettings(
    "start_session",
    harness,
    [],
    input.workspace?.id,
    input
  );
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
      `start_session: thinking: ${JSON.stringify(level)} is not a level ${settings.model} offers; ${levels.length ? `its levels are ${levels.map((l) => JSON.stringify(l)).join(", ")}` : "it has no thinking levels"}. Nothing was started.`
    );
  return settings;
}

export async function continuedSettings(
  harness: AgentHarness,
  turns: readonly SessionTurn[],
  workspaceId: string
): Promise<TurnSettings> {
  const { settings } = await resolveSettings("send_message", harness, turns, workspaceId);
  return settings;
}
