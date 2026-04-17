// Agent catalog — thinking-level helpers.
//
// The frontend only cares about *which* levels a given model supports
// and how to cycle them. The mapping from level → SDK option (token
// budget today, `effort` string tomorrow) lives in the agent-server —
// see apps/agent-server/agents/claude/thinking.ts.

import { getAgentConfig } from "./lookup";
import type { AgentHarness, ThinkingLevel } from "./types";

/**
 * Returns the thinking levels available for a given model.
 * Falls back to the agent's default levels when the model doesn't declare its own.
 * An empty array means the model doesn't support thinking (hide the indicator).
 */
export function getThinkingLevelsForModel(
  agentHarness: AgentHarness,
  model: string
): readonly ThinkingLevel[] {
  const config = getAgentConfig(agentHarness);
  const modelOption = config.models.find((m) => m.model === model);
  return modelOption?.thinkingLevels ?? config.thinkingLevels;
}

/**
 * Computes the next thinking level on click.
 *
 * Walks the model's thinkingLevels array, wrapping at the end.
 * NONE is normalized to the first entry (thinking is always "on").
 *
 * Opus 4.7: ["LOW", "HIGH", "XHIGH"] → 3-step with Opus-4.7-era xhigh
 * Claude (default): ["LOW", "HIGH"] → LOW ↔ HIGH (binary toggle)
 * Codex: ["LOW", "MEDIUM", "HIGH"] → 3-step graduated reasoning
 * Haiku: [] → indicator hidden; callers receive NONE
 */
export function cycleThinkingLevel(
  current: ThinkingLevel,
  agentHarness: AgentHarness,
  model: string
): ThinkingLevel {
  const thinkingLevels = getThinkingLevelsForModel(agentHarness, model);
  if (thinkingLevels.length === 0) return "NONE";
  const normalized = current === "NONE" ? thinkingLevels[0] : current;
  const idx = thinkingLevels.indexOf(normalized);
  const safeIdx = idx === -1 ? 0 : idx;
  return thinkingLevels[(safeIdx + 1) % thinkingLevels.length];
}
