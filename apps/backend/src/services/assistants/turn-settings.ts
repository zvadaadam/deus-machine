// backend/src/services/assistants/turn-settings.ts
// The agent, model, thinking level and permission mode an assistant's message
// runs with: the ones the app's own composer would send to continue that chat
// (apps/web: SessionComposer seeds the latest turn's model and thinking level,
// with plan mode off).

import type { AgentHarness } from "@shared/enums";
import {
  DEFAULT_THINKING_LEVEL,
  continuedThinkingLevel,
  defaultModelValue,
  latestTurnExecution,
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
 * - Model and thinking: the ones its latest turn on that agent ran
 *   (`latestTurnExecution`); a chat with none starts on the agent's default
 *   model (`defaultModelValue`) and the person's default level (Settings, AI),
 *   else Deus's. The engine runs the nearest level the model has.
 * - Permission mode: none, the composer's own (plan mode off), so the agent
 *   runs with the full access Deus gives every chat.
 */
export function turnSettings(
  harness: AgentHarness,
  turns: readonly SessionTurn[],
  defaultThinking: unknown
): TurnSettings {
  const latest = latestTurnExecution(harness, turns);
  const selection =
    (latest?.model && parseModelValue(modelValue(harness, latest.model))) ||
    parseModelValue(defaultModelValue(harness))!;
  return {
    agentHarness: selection.harness,
    model: selection.model,
    thinkingLevel:
      continuedThinkingLevel(latest) ??
      readThinkingLevel(defaultThinking) ??
      DEFAULT_THINKING_LEVEL,
  };
}
