// What the composer knows about a chat's harness and model without a list.
// The models themselves come from the engine (useModelLists); a picker value
// is `harness:model`, so the harness and the model id are read from it.
//
// Harness lock: once a session has messages its harness is fixed (the engine
// binds a session to one runtime on its first turn). Models within the harness
// can change; another harness needs a new chat.

import {
  DEFAULT_AGENT_HARNESS,
  continuedThinkingLevel,
  latestTurnExecution,
  modelValue,
  parseModelValue,
} from "@shared/models";
import type { AgentHarness } from "@shared/enums";
import { harnessInfo } from "@shared/harnesses";
import type { ThinkingLevel } from "@shared/protocol";
import type { SessionTurn } from "@shared/types/session";

export {
  DEFAULT_MODEL,
  DEFAULT_THINKING_LEVEL,
  composerThinking,
  fitThinkingLevel,
  modelLabel,
  modelThinkingLevels,
  modelValue,
  pickerModels,
  thinkingLevelLabel,
} from "@shared/models";
export type { AgentHarness } from "@shared/enums";
export type { ThinkingLevel } from "@shared/protocol";

export function getAgentLabel(agentHarness: string): string {
  return harnessInfo(agentHarness)?.label ?? agentHarness;
}

/** The picker value a stored one names today; undefined when it names no harness Deus runs. */
export function resolveModelSelection(model: string): string | undefined {
  const parsed = parseModelValue(model);
  return parsed && modelValue(parsed.harness, parsed.model);
}

export function getAgentHarnessForModel(model: string): AgentHarness {
  return parseModelValue(model)?.harness ?? DEFAULT_AGENT_HARNESS;
}

/** The model id a picker value sends to the engine. Throws on a value that names no harness. */
export function getModelId(model: string): string {
  const parsed = parseModelValue(model);
  if (!parsed) throw new Error(`[agents] "${model}" names no harness and model`);
  return parsed.model;
}

/** Reopen on the last recorded thinking level; a chat with none uses `fallback`. */
export function getThinkingForSession(
  agentHarness: string,
  turns: readonly SessionTurn[],
  fallback: ThinkingLevel
): ThinkingLevel {
  return continuedThinkingLevel(latestTurnExecution(agentHarness, turns)) ?? fallback;
}
