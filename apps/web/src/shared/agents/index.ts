// Agent catalog — single source of truth for which agents/models the UI
// exposes, plus the helpers for looking them up and cycling thinking
// levels. The server-side runtime (agent handlers, SDK option translation)
// lives in apps/agent-server/agents/.
//
// Harness lock constraint: once a session has messages, its agent type
// (claude or codex) is fixed — the agent-server binds to a specific SDK on
// first query and cannot switch mid-session. Within the same harness, model
// switching is allowed (e.g. Sonnet → Opus). The UI enforces this by
// disabling cross-group items in the model picker when hasMessages is true;
// see MessageInput's model picker dropdown.

// ============================================================================
// Types
// ============================================================================

export type AgentHarness = "claude" | "codex";

export type ThinkingLevel = "NONE" | "LOW" | "MEDIUM" | "HIGH" | "XHIGH";

/** A model entry in the picker. Associated with exactly one agent type. */
export interface AgentModelOption {
  /** Model identifier sent to the agent-server */
  readonly model: string;
  /** Human-readable label */
  readonly label: string;
  /** Show "New" badge in picker */
  readonly isNew?: boolean;
  /**
   * Ordered thinking levels the user cycles through for this model.
   * Overrides the agent-level default. Empty array hides the thinking indicator.
   */
  readonly thinkingLevels?: readonly ThinkingLevel[];
}

/**
 * Per-agent configuration record. Adding a new agent means adding one entry
 * to AGENT_CONFIGS — UI files consume this data via lookup helpers, so no
 * file-level conditionals.
 */
export interface AgentConfig {
  /** DB-compatible agent_harness string (matches sessions.agent_harness) */
  readonly id: AgentHarness;
  /** Human label for display (e.g. "Claude", "Codex") */
  readonly label: string;
  /** Group header label in model picker dropdown */
  readonly groupLabel: string;
  /** Default thinking levels when a model doesn't declare its own */
  readonly thinkingLevels: readonly ThinkingLevel[];
  /** Available models, in display order */
  readonly models: readonly AgentModelOption[];
}

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

export const AGENT_CONFIGS = {
  claude: {
    id: "claude" as const,
    label: "Claude",
    groupLabel: "Claude Code",
    thinkingLevels: ["LOW", "MEDIUM", "HIGH"] as const,
    models: [
      {
        model: "claude-opus-4-7",
        label: "Opus 4.7",
        isNew: true,
        thinkingLevels: ["LOW", "MEDIUM", "HIGH", "XHIGH"] as const,
      },
      { model: "claude-opus-4-6", label: "Opus 4.6" },
      { model: "claude-sonnet-4-6", label: "Sonnet 4.6", isNew: true },
      { model: "claude-haiku-4-5", label: "Haiku 4.5", thinkingLevels: [] as const },
    ],
  },
  codex: {
    id: "codex" as const,
    label: "Codex",
    groupLabel: "Codex",
    thinkingLevels: ["LOW", "MEDIUM", "HIGH"] as const,
    models: [
      { model: "gpt-5.3-codex", label: "GPT-5.3 Codex", isNew: true },
      { model: "gpt-5.2-codex", label: "GPT-5.2 Codex" },
      { model: "gpt-5.3-codex-spark", label: "Codex Spark" },
    ],
  },
} satisfies Record<AgentHarness, AgentConfig>;

/** Agent types that appear in the model picker (ordered). */
export const MODEL_PICKER_GROUPS: readonly AgentConfig[] = [
  AGENT_CONFIGS.claude,
  AGENT_CONFIGS.codex,
];

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

// ============================================================================
// Lookup
// ============================================================================

/**
 * Resolve an agent config by type. Falls back to Claude for unknown types;
 * logs a dev-only warning so drift from the catalog doesn't silently misroute
 * users in production.
 */
function getAgentConfig(agentHarness: string): AgentConfig {
  const normalized = agentHarness.toLowerCase() as AgentHarness;
  const config = AGENT_CONFIGS[normalized];
  if (!config) {
    if (import.meta.env.DEV) {
      console.warn(`[agents] Unknown agent type "${agentHarness}", defaulting to claude.`);
    }
    return AGENT_CONFIGS.claude;
  }
  return config;
}

export function getAgentLabel(agentHarness: string): string {
  return getAgentConfig(agentHarness).label;
}

/**
 * Resolve a model option by its `harness:model` value.
 * Returns undefined for unrecognized values.
 */
export function getModelOption(model: string): ModelOption | undefined {
  const normalized = model.toLowerCase().trim();
  return MODEL_OPTIONS.find((option) => option.value === normalized);
}

export function getModelLabel(model: string): string {
  return getModelOption(model)?.label ?? model;
}

export function getAgentHarnessForModel(model: string): AgentHarness {
  const option = getModelOption(model);
  if (option) return option.agentHarness;
  // Unknown models: use the harness prefix if present, default to claude.
  return model.toLowerCase().startsWith("codex:") ? "codex" : "claude";
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
