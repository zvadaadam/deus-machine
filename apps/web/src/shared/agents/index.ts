// What the composer knows about a chat's harness and model without a list.
// The models themselves come from the engine (useModelLists); a picker value
// is `harness:model`, so the harness and the model id are read from it.
//
// Harness lock: once a session has messages its harness is fixed (the engine
// binds a session to one runtime on its first turn). Models within the harness
// can change; another harness needs a new chat.

import { HARNESS_LABELS, defaultModelValue, modelValue, parseModelValue } from "@shared/models";
import type { AgentHarness } from "@shared/enums";
import type { SessionTurn } from "@shared/types/session";

export {
  DEFAULT_MODEL,
  DEFAULT_THINKING_LEVEL,
  PICKER_HARNESSES,
  fitThinkingLevel,
  modelLabel,
  modelThinkingLevels,
  modelValue,
  pickerModels,
  type HarnessModels,
} from "@shared/models";
export type { AgentHarness } from "@shared/enums";
export type { ThinkingLevel } from "@shared/protocol";

export function getAgentLabel(agentHarness: AgentHarness): string {
  return HARNESS_LABELS[agentHarness];
}

/** The picker value a stored one names today; undefined when it names no harness Deus runs. */
export function resolveModelSelection(model: string): string | undefined {
  const parsed = parseModelValue(model);
  return parsed && modelValue(parsed.harness, parsed.model);
}

export function getAgentHarnessForModel(model: string): AgentHarness {
  return parseModelValue(model)?.harness ?? "claude-code";
}

/** The model id a picker value sends to the engine. Throws on a value that names no harness. */
export function getModelId(model: string): string {
  const parsed = parseModelValue(model);
  if (!parsed) throw new Error(`[agents] "${model}" names no harness and model`);
  return parsed.model;
}

/** Fallback for a session with no recorded selection, preserving its harness. */
export function getDefaultModelForHarness(agentHarness: AgentHarness): string {
  return defaultModelValue(agentHarness);
}

/** Reopen with the last recorded selection; an empty session uses its harness default. */
export function getModelForSession(
  agentHarness: AgentHarness,
  turns: readonly SessionTurn[]
): string {
  const latest = turns.reduce<SessionTurn | undefined>((previous, turn) => {
    if (turn.execution?.harness !== agentHarness || !turn.execution.model) return previous;
    return !previous ||
      (turn.startedAt ?? turn.endedAt ?? 0) > (previous.startedAt ?? previous.endedAt ?? 0)
      ? turn
      : previous;
  }, undefined);
  const model = latest?.execution?.model;
  return (
    (model && resolveModelSelection(modelValue(agentHarness, model))) ||
    getDefaultModelForHarness(agentHarness)
  );
}
