// Agent catalog helpers. Shared metadata lives in shared/agent-catalog.ts;
// runtime SDK/process implementations live in apps/agent-server/agents/.
//
// Harness lock constraint: once a session has messages, its agent type is
// fixed — the agent-server binds to a specific runtime on first query and
// cannot switch mid-session. The UI currently exposes Claude Code and Codex;
// the legacy codex-sdk harness remains registered for backend/CLI compatibility.

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

const CODEX_SERVER_DEFAULT_MODEL = `${AGENT_CONFIGS["codex-app-server"].id}:${AGENT_CONFIGS["codex-app-server"].models[0].model}`;

/** Retired harness prefixes in persisted picker values → the engine ids. */
const RETIRED_HARNESS_PREFIXES: ReadonlyArray<[string, AgentHarness]> = [
  ["claude:", "claude-code"],
  ["codex-server:", "codex-app-server"],
];

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

/**
 * The picker value a session should open with when nothing else says: its
 * harness's first catalog model. This is what seeds the composer for a
 * HYDRATED tab (a session reopened from the sidebar) — without it the composer
 * fell back to the global default (Claude), and a Codex session's first send
 * ran as Claude, forking a fresh native conversation.
 */
export function getDefaultModelForHarness(agentHarness: AgentHarness): string {
  const config = getAgentConfig(agentHarness);
  return `${config.id}:${config.models[0].model}`;
}

export function resolveModelSelection(model: string): string | undefined {
  const candidate = model.toLowerCase().trim();
  if (MODEL_OPTIONS.some((option) => option.value === candidate)) {
    return candidate;
  }

  // LocalStorage/tabs can still hold picker values from older builds: the
  // pre-codex-server harnesses, and the retired deus harness spellings that
  // the engine ids replaced (claude → claude-code, codex-server →
  // codex-app-server). Treat those as a one-time selection migration; runtime
  // harness ids are validated separately at the RPC boundary.
  if (candidate.startsWith("codex:") || candidate.startsWith("codex-sdk:")) {
    return CODEX_SERVER_DEFAULT_MODEL;
  }
  const retired = RETIRED_HARNESS_PREFIXES.find(([prefix]) => candidate.startsWith(prefix));
  if (retired) {
    const migrated = `${retired[1]}:${candidate.slice(retired[0].length)}`;
    return MODEL_OPTIONS.some((option) => option.value === migrated) ? migrated : undefined;
  }

  return undefined;
}

/**
 * Resolve a model option by its `harness:model` value.
 * Returns undefined for unrecognized values.
 */
export function getModelOption(model: string): ModelOption | undefined {
  const resolved = resolveModelSelection(model);
  if (!resolved) return undefined;
  return MODEL_OPTIONS.find((option) => option.value === resolved);
}

export function getModelLabel(model: string): string {
  return getModelOption(model)?.label ?? model;
}

export function getAgentHarnessForModel(model: string): AgentHarness {
  const option = getModelOption(model);
  return option?.agentHarness ?? "claude-code";
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
// The frontend only cares which levels a model supports and how to cycle them.
// Provider SDK mappings live in the agent-server harnesses.

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
 * array, wrapping at the end.
 *
 * "off" enters the ladder AT the first entry rather than one past it: turning
 * thinking on is a click that should land on the lowest level, and skipping
 * "low" left no way to reach it from off without wrapping the whole ladder.
 * (The old code normalized "off" to `thinkingLevels[0]` and then advanced,
 * yielding the SECOND entry — the doc above it always claimed otherwise.)
 *
 * Opus 4.7: ["low", "medium", "high", "xhigh"] — full ladder incl. xhigh
 * Claude (default): ["low", "medium", "high"] — shared by Opus 4.6 / Sonnet 4.6
 * Codex: ["low", "medium", "high"] — graduated reasoning
 * Haiku: [] → indicator hidden; callers receive "off"
 */
export function cycleThinkingLevel(
  current: ThinkingLevel,
  agentHarness: AgentHarness,
  model: string
): ThinkingLevel {
  const thinkingLevels = getThinkingLevelsForModel(agentHarness, model);
  if (thinkingLevels.length === 0) return "off";
  if (current === "off") return thinkingLevels[0];
  const idx = thinkingLevels.indexOf(current);
  // A level the model does not expose (a stale pick carried across a model
  // switch) is treated as off — enter at the first entry.
  if (idx === -1) return thinkingLevels[0];
  return thinkingLevels[(idx + 1) % thinkingLevels.length];
}

/**
 * Snap a thinking level into what the target model actually supports.
 *
 * Use on model change: e.g. Opus 4.7 user on xhigh switches to Opus 4.6,
 * which doesn't expose xhigh — snap to `fallback` (or the model's top level
 * if the fallback isn't supported either). Returns "off" when the model
 * declares no thinking levels (Haiku).
 */
export function clampThinkingLevel(
  current: ThinkingLevel,
  agentHarness: AgentHarness,
  model: string,
  fallback: ThinkingLevel = "high"
): ThinkingLevel {
  const supported = getThinkingLevelsForModel(agentHarness, model);
  if (supported.length === 0) return "off";
  if (supported.includes(current)) return current;
  if (supported.includes(fallback)) return fallback;
  return supported[supported.length - 1];
}
