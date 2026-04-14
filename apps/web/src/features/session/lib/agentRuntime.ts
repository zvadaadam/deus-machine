export type RuntimeAgentType = "claude" | "codex";

export type ThinkingLevel = "NONE" | "LOW" | "MEDIUM" | "HIGH";

/**
 * Agent type lock constraint:
 * Once a session has messages (message_count > 0), its agent harness
 * (claude or codex) is fixed for the session's lifetime. The agent-server
 * binds to a specific SDK on first query and cannot switch mid-session.
 *
 * - Within the same harness: model switching is allowed (e.g. Sonnet → Opus)
 * - Across harnesses: requires opening a new chat tab (new session)
 *
 * The UI enforces this by disabling cross-group items in the model picker
 * when hasMessages is true. See MessageInput's model picker dropdown.
 */

// ── Agent Model Option ───────────────────────────────────────────────

interface AgentModelOption {
  /** Model identifier sent to the agent-server */
  model: string;
  /** Human-readable label */
  label: string;
  /** Show "New" badge in picker */
  isNew?: boolean;
}

// ── Agent Config ─────────────────────────────────────────────────────

/**
 * Per-agent configuration record.
 *
 * Every agent-specific behavior lives here. Adding a new agent means
 * adding one entry to AGENT_CONFIGS — no UI files need conditionals.
 *
 * - thinkingLevels: ordered cycle array, walked by cycleThinkingLevel()
 * - models: available models for the model picker dropdown
 * - groupLabel: header text in the model picker ("Claude Code", "Codex")
 */
interface AgentConfig {
  /** DB-compatible agent_type string (matches sessions.agent_type) */
  readonly id: RuntimeAgentType;
  /** Human label for display (e.g. "Claude", "Codex") */
  readonly label: string;
  /** Group header label in model picker dropdown */
  readonly groupLabel: string;
  /** Ordered thinking levels the user cycles through on click */
  readonly thinkingLevels: readonly ThinkingLevel[];
  /** Available models, in display order */
  readonly models: readonly AgentModelOption[];
}

const AGENT_CONFIGS = {
  claude: {
    id: "claude" as const,
    label: "Claude",
    groupLabel: "Claude Code",
    thinkingLevels: ["LOW", "HIGH"] as const,
    models: [
      { model: "opus", label: "Opus 4.6" },
      { model: "sonnet", label: "Sonnet 4.6", isNew: true },
      { model: "haiku", label: "Haiku 4.5" },
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
} satisfies Record<RuntimeAgentType, AgentConfig>;

/** Get the config for an agent type. Falls back to "claude" for unrecognized types. */
function getAgentConfig(agentType: string): AgentConfig {
  const normalized = agentType.toLowerCase() as RuntimeAgentType;
  return AGENT_CONFIGS[normalized] ?? AGENT_CONFIGS.claude;
}

/** Agent types that appear in the model picker. */
export const MODEL_PICKER_GROUPS: readonly AgentConfig[] = [
  AGENT_CONFIGS.claude,
  AGENT_CONFIGS.codex,
];

// ── Thinking Level Cycling ───────────────────────────────────────────

/**
 * Computes the next thinking level on click.
 *
 * Walks the agent's thinkingLevels array, wrapping at the end.
 * NONE is normalized to the first entry (thinking is always "on").
 *
 * Claude: ["LOW", "HIGH"] → LOW ↔ HIGH (binary toggle)
 * Codex:  ["LOW", "MEDIUM", "HIGH"] → 3-step graduated reasoning
 */
export function cycleThinkingLevel(
  current: ThinkingLevel,
  agentType: RuntimeAgentType
): ThinkingLevel {
  const { thinkingLevels } = getAgentConfig(agentType);
  const normalized = current === "NONE" ? thinkingLevels[0] : current;
  const idx = thinkingLevels.indexOf(normalized);
  const safeIdx = idx === -1 ? 0 : idx;
  return thinkingLevels[(safeIdx + 1) % thinkingLevels.length];
}

// ── Runtime Model Options (derived from config) ──────────────────────

export interface RuntimeModelOption {
  /** Unique picker value (harness:model) */
  value: string;
  /** Actual model identifier to send to runtime/backend */
  model: string;
  label: string;
  agentType: RuntimeAgentType;
  group: "claude" | "codex";
  isNew?: boolean;
}

/** Flat model options array, derived from agent configs. */
export const RUNTIME_MODEL_OPTIONS: RuntimeModelOption[] = MODEL_PICKER_GROUPS.flatMap((config) =>
  config.models.map(
    (m): RuntimeModelOption => ({
      value: `${config.id}:${m.model}`,
      model: m.model,
      label: m.label,
      agentType: config.id,
      group: config.id as "claude" | "codex",
      isNew: m.isNew,
    })
  )
);

// ── Utility functions (unchanged signatures) ─────────────────────────

export function getRuntimeAgentLabel(agentType: string): string {
  return getAgentConfig(agentType).label;
}

export function getRuntimeModelOption(model: string): RuntimeModelOption | undefined {
  const normalized = model.toLowerCase().trim();

  // New format: "harness:model" from the unified picker
  if (normalized.includes(":")) {
    return RUNTIME_MODEL_OPTIONS.find((option) => option.value === normalized);
  }

  // Backward compatibility for persisted values
  if (normalized === "codex") {
    return RUNTIME_MODEL_OPTIONS.find((option) => option.value === "codex:gpt-5.3-codex");
  }

  // Legacy plain model values default to Claude harness
  return RUNTIME_MODEL_OPTIONS.find(
    (option) => option.agentType === "claude" && option.model === normalized
  );
}

export function getRuntimeModelLabel(model: string): string {
  const option = getRuntimeModelOption(model);
  if (option) return option.label;

  const normalized = model.toLowerCase().trim();
  if (normalized.includes(":")) {
    const [, modelName] = normalized.split(":");
    return modelName || model;
  }

  return model;
}

export function getRuntimeAgentTypeForModel(model: string): RuntimeAgentType {
  const option = getRuntimeModelOption(model);
  if (option) return option.agentType;

  return model.toLowerCase().startsWith("codex:") ? "codex" : "claude";
}

export function getRuntimeModelId(model: string): string {
  const option = getRuntimeModelOption(model);
  if (option) return option.model;

  const normalized = model.toLowerCase().trim();
  if (normalized.includes(":")) {
    const [, modelName] = normalized.split(":");
    return modelName || "opus";
  }

  return normalized;
}
