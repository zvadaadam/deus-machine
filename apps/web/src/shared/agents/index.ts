// Agent catalog helpers. Shared metadata lives in shared/agent-catalog.ts;
// runtime SDK/process implementations live in apps/agent-server/agents/.
//
// Harness lock constraint: once a session has messages, its agent type is
// fixed — the agent-server binds to a specific runtime on first query and
// cannot switch mid-session. The UI currently exposes Claude Code and Codex;
// the Codex picker entry routes to the codex-server/app-server harness. The
// legacy codex-sdk harness remains registered for backend/CLI compatibility.

import {
  AGENT_CONFIGS,
  DEFAULT_MODEL,
  MODEL_PICKER_GROUPS,
  getKnownAgentConfig,
} from "@shared/agent-catalog";
import type { AgentConfig, AgentHarness, ThinkingLevel } from "@shared/agent-catalog";

export {
  AGENT_CONFIGS,
  DEFAULT_MODEL,
  MODEL_PICKER_GROUPS,
  type AgentConfig,
  type AgentHarness,
  type AgentModelOption,
  type ThinkingLevel,
} from "@shared/agent-catalog";

// ============================================================================
// Types
// ============================================================================

/** Flat-listed model option derived from an AgentConfig. */
export interface ModelOption {
  /** Unique picker value (harness:model) */
  value: string;
  /** Actual model identifier to send to runtime/backend */
  model: string;
  label: string;
  agentHarness: AgentHarness;
  isNew?: boolean;
}

// ============================================================================
// Catalog
// ============================================================================

/** Flat model options array, derived from agent configs. */
export const MODEL_OPTIONS: ModelOption[] = MODEL_PICKER_GROUPS.flatMap((config) =>
  config.models.map(
    (m): ModelOption => ({
      value: `${config.id}:${m.model}`,
      model: m.model,
      label: m.label,
      agentHarness: config.id,
      isNew: m.isNew,
    })
  )
);

const CODEX_SERVER_DEFAULT_MODEL = `${AGENT_CONFIGS["codex-server"].id}:${AGENT_CONFIGS["codex-server"].models[0].model}`;

// ============================================================================
// Lookup
// ============================================================================

/**
 * Resolve an agent config by typed harness. Untyped boundaries should validate
 * before calling into the catalog.
 */
function getAgentConfig(agentHarness: AgentHarness): AgentConfig {
  return getKnownAgentConfig(agentHarness);
}

export function getAgentLabel(agentHarness: AgentHarness): string {
  return getAgentConfig(agentHarness).label;
}

export function normalizeModelSelection(model: string): string | undefined {
  const normalized = model.toLowerCase().trim();
  if (MODEL_OPTIONS.some((option) => option.value === normalized)) {
    return normalized;
  }

  // Legacy frontend selections from the hidden Codex SDK harness should now
  // behave like the user picked the visible Codex option.
  if (normalized.startsWith("codex:") || normalized.startsWith("codex-sdk:")) {
    return CODEX_SERVER_DEFAULT_MODEL;
  }

  return undefined;
}

/**
 * Resolve a model option by its `harness:model` value.
 * Returns undefined for unrecognized values.
 */
export function getModelOption(model: string): ModelOption | undefined {
  const normalized = normalizeModelSelection(model);
  if (!normalized) return undefined;
  return MODEL_OPTIONS.find((option) => option.value === normalized);
}

export function getModelLabel(model: string): string {
  return getModelOption(model)?.label ?? model;
}

export function getAgentHarnessForModel(model: string): AgentHarness {
  const option = getModelOption(model);
  return option?.agentHarness ?? "claude";
}

/**
 * Extract the bare model ID from a `harness:model` picker value.
 * Throws if the value isn't in the catalog — callers should pass validated
 * picker values, so a miss here means stale localStorage or a bug.
 */
export function getModelId(model: string): string {
  const option = getModelOption(model);
  if (!option) {
    throw new Error(`[agents] Unknown model "${model}" — not in catalog`);
  }
  return option.model;
}

// ============================================================================
// Thinking
// ============================================================================
//
// The frontend only cares about *which* levels a given model supports and
// how to cycle them. The mapping from level → SDK option (token budget
// today, `effort` string tomorrow) lives in the agent-server — see
// apps/agent-server/agents/claude/claude-sdk-options.ts (resolveThinkingOptions).

/**
 * Returns the thinking levels available for a given model. Falls back to
 * the agent's default levels when the model doesn't declare its own. An
 * empty array means the model doesn't support thinking (hide the indicator).
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
 * Computes the next thinking level on click. Walks the model's thinkingLevels
 * array, wrapping at the end. NONE is normalized to the first entry.
 *
 * Opus 4.7: ["LOW", "MEDIUM", "HIGH", "XHIGH"] — full ladder incl. xhigh
 * Claude (default): ["LOW", "MEDIUM", "HIGH"] — shared by Opus 4.6 / Sonnet 4.6
 * Codex: ["LOW", "MEDIUM", "HIGH"] — graduated reasoning
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

/**
 * Snap a thinking level into what the target model actually supports.
 *
 * Use on model change: e.g. Opus 4.7 user on XHIGH switches to Opus 4.6,
 * which doesn't expose XHIGH — snap to `fallback` (or the model's top level
 * if the fallback isn't supported either). Returns "NONE" when the model
 * declares no thinking levels (Haiku).
 */
export function clampThinkingLevel(
  current: ThinkingLevel,
  agentHarness: AgentHarness,
  model: string,
  fallback: ThinkingLevel = "HIGH"
): ThinkingLevel {
  const supported = getThinkingLevelsForModel(agentHarness, model);
  if (supported.length === 0) return "NONE";
  if (supported.includes(current)) return current;
  if (supported.includes(fallback)) return fallback;
  return supported[supported.length - 1];
}
