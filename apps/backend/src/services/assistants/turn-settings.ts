// backend/src/services/assistants/turn-settings.ts
// The agent, model, thinking level and permission mode an assistant's message
// runs with: the ones the app's own composer would send to continue that chat
// (apps/web: SessionComposer seeds `getModelForSession`, the composer store
// starts on the default thinking level with plan mode off).

import type { AgentHarness } from "@shared/enums";
import {
  DEFAULT_THINKING_LEVEL,
  defaultModelValue,
  latestTurnModel,
  modelValue,
  parseModelValue,
} from "@shared/models";
import { readThinkingLevel, type ThinkingLevel } from "@shared/protocol";
import type { SessionTurn } from "@shared/types/session";

export interface TurnSettings {
  agentHarness: AgentHarness;
  model: string;
  thinkingLevel: ThinkingLevel;
}

/**
 * - Agent: the chat's own (a chat keeps its agent once it has messages).
 * - Model: the one its latest turn on that agent ran (`latestTurnModel`); a
 *   chat with none starts on the agent's default (Deus's preference,
 *   `defaultModelValue`).
 * - Thinking: the person's default (Settings, AI), else Deus's; the engine
 *   runs the nearest level the model has.
 * - Permission mode: none, the composer's own (plan mode off), so the agent
 *   runs with the full access Deus gives every chat.
 */
export function turnSettings(
  harness: AgentHarness,
  turns: readonly SessionTurn[],
  defaultThinking: unknown
): TurnSettings {
  const chosen = latestTurnModel(harness, turns);
  const selection =
    (chosen && parseModelValue(modelValue(harness, chosen))) ||
    parseModelValue(defaultModelValue(harness))!;
  return {
    agentHarness: selection.harness,
    model: selection.model,
    thinkingLevel: readThinkingLevel(defaultThinking) ?? DEFAULT_THINKING_LEVEL,
  };
}
