export type RuntimeAgentType = "claude" | "codex" | "unknown";

/**
 * Agent type lock constraint:
 * Once a session has messages (message_count > 0), its agent harness
 * (claude or codex) is fixed for the session's lifetime. The sidecar
 * binds to a specific SDK on first query and cannot switch mid-session.
 *
 * - Within the same harness: model switching is allowed (e.g. Sonnet → Opus)
 * - Across harnesses: requires opening a new chat tab (new session)
 *
 * The UI enforces this by disabling cross-group items in the model picker
 * when hasMessages is true. See MessageInput's model picker dropdown.
 */

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

export const RUNTIME_MODEL_OPTIONS: RuntimeModelOption[] = [
  {
    value: "claude:opus",
    model: "opus",
    label: "Opus 4.6",
    agentType: "claude",
    group: "claude",
  },
  {
    value: "claude:sonnet",
    model: "sonnet",
    label: "Sonnet 4.6",
    agentType: "claude",
    group: "claude",
    isNew: true,
  },
  {
    value: "claude:haiku",
    model: "haiku",
    label: "Haiku 4.5",
    agentType: "claude",
    group: "claude",
  },
  {
    value: "codex:gpt-5.3-codex",
    model: "gpt-5.3-codex",
    label: "GPT-5.3 Codex",
    agentType: "codex",
    group: "codex",
    isNew: true,
  },
  {
    value: "codex:gpt-5.2-codex",
    model: "gpt-5.2-codex",
    label: "GPT-5.2 Codex",
    agentType: "codex",
    group: "codex",
  },
  {
    value: "codex:codex-spark",
    model: "gpt-5.3-codex-spark",
    label: "Codex Spark",
    agentType: "codex",
    group: "codex",
  },
];

const AGENT_LABELS: Record<RuntimeAgentType, string> = {
  claude: "Claude",
  codex: "Codex",
  unknown: "Agent",
};

export function getRuntimeAgentLabel(agentType: string): string {
  const normalized = agentType.toLowerCase() as RuntimeAgentType;
  return AGENT_LABELS[normalized] ?? AGENT_LABELS.unknown;
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
