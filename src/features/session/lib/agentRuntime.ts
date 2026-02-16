export type RuntimeAgentType = "claude" | "codex" | "unknown";

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
    label: "Opus 4.5",
    agentType: "claude",
    group: "claude",
    isNew: true,
  },
  {
    value: "claude:sonnet",
    model: "sonnet",
    label: "Sonnet 4.5",
    agentType: "claude",
    group: "claude",
  },
  {
    value: "claude:haiku",
    model: "haiku",
    label: "Haiku 3.5",
    agentType: "claude",
    group: "claude",
  },
  {
    value: "codex:o3",
    model: "o3",
    label: "o3",
    agentType: "codex",
    group: "codex",
    isNew: true,
  },
  {
    value: "codex:o4-mini",
    model: "o4-mini",
    label: "o4-mini",
    agentType: "codex",
    group: "codex",
  },
  {
    value: "codex:gpt-4.1",
    model: "gpt-4.1",
    label: "GPT-4.1",
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
    return RUNTIME_MODEL_OPTIONS.find((option) => option.value === "codex:o4-mini");
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
    return modelName || "sonnet";
  }

  return normalized;
}
