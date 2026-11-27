// backend/src/services/agent/turn-settings.ts
// The settings an operator's first message or follow-up takes to the engine.

import { OperatorError, type StartInput } from "@zvada/agent-server/operator";
import { agentModels } from "@shared/api/settings";
import type { AgentHarness } from "@shared/enums";
import { HARNESSES, knownHarness } from "@shared/harnesses";
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
import { runAsThisComputer as run } from "../query-engine";
import { getSessionRaw, getTurn, recentTurns } from "../../db";
import { getDatabase } from "../../lib/database";
import { holdingTurn } from "./chat-turn";
import { getSetting } from "../settings.service";

export interface TurnSettings {
  agentHarness: AgentHarness;
  model: string;
  thinkingLevel: ThinkingLevel;
  gatewayRevision?: string;
}

function defaultThinking() {
  return readThinkingLevel(getSetting("default_thinking_level")) ?? DEFAULT_THINKING_LEVEL;
}

/** Only a choice left to Deus can come from the catalog when the list cannot be read. */
async function chooseModel(harness: AgentHarness, input: StartInput) {
  let lists: readonly HarnessModels[];
  try {
    lists = (await run(agentModels, { harness, workspaceId: input.workspace?.id })).lists;
  } catch {
    if (!input.model && !input.thinkingLevel) {
      const model = defaultModelId(CATALOG_MODEL_LISTS, harness);
      if (model) return { model };
    }
    return { reason: "the model list could not be read right now." };
  }
  const own = lists.find((list) => list.harness === harness);
  const fallback = defaultModelId(lists, harness);
  if (!fallback) {
    const why = own?.error ? ` (${JSON.stringify(own.error)})` : "";
    return {
      reason: `no models are available to choose for ${HARNESSES[harness].label}${why}. Ask the person to check the agent in Settings → AI Providers.`,
    };
  }
  const model = input.model ?? fallback;
  const row = findModel(lists, harness, model)?.row;
  const levels = own?.source === "live" ? row?.thinking.levels : undefined;
  return { model, row, levels };
}

export async function startSettings(
  harness: AgentHarness,
  input: StartInput
): Promise<TurnSettings> {
  const pick = await chooseModel(harness, input);
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

export function continuedSettings(sessionId: string): TurnSettings {
  const db = getDatabase();
  const session = getSessionRaw(db, sessionId);
  if (!session) throw new OperatorError("not_found", "That session is gone. Nothing was sent.");
  const harness = knownHarness(session.agent_harness);
  if (!harness)
    throw new OperatorError(
      "unsupported",
      `send_message: this chat's agent ${JSON.stringify(session.agent_harness)} does not run here. Nothing was sent.`
    );
  const active = holdingTurn(sessionId);
  const turns = recentTurns(db, sessionId);
  const recorded = active && turns.find((turn) => turn.turnId === active.turnId)?.execution;
  // Between admission and turn.started, the holder owns the requested settings.
  const requested = !recorded?.model ? active?.requested : undefined;
  // The operator does not pass its cutoff, so a send falls back to the catalog, the only list that needs no read.
  const gateway = active?.gateway;
  const gatewayRevision = gateway?.binding.revision ?? session.gateway_revision;
  const latest = recorded?.model ? recorded : latestTurnExecution(harness, turns);
  const model =
    requested?.model ??
    gateway?.execution.model ??
    latest?.model ??
    (gatewayRevision ? undefined : defaultModelId(CATALOG_MODEL_LISTS, harness));
  if (!model)
    throw new OperatorError(
      "unsupported",
      `send_message: this chat has no recorded model. Ask the person to choose a model for ${HARNESSES[harness].label} in the chat, or use start_session with a model. Nothing was sent.`
    );
  return {
    agentHarness: harness,
    model,
    ...(gatewayRevision && { gatewayRevision }),
    thinkingLevel:
      readThinkingLevel(requested?.thinkingLevel) ??
      continuedThinkingLevel(latest) ??
      defaultThinking(),
  };
}

/** A mode belongs to the active turn as soon as it is requested, then to its recorded execution. */
export function continuedPermissionMode(sessionId: string) {
  const db = getDatabase();
  const active = holdingTurn(sessionId);
  if (!active) return recentTurns(db, sessionId, 1)[0]?.execution?.permissionMode;
  const execution = getTurn(db, sessionId, active.turnId)?.execution;
  return execution ? execution.permissionMode : active.requested?.permissionMode;
}
