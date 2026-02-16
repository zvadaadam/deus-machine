// sidecar/agents/codex/codex-models.ts
// Model name mapping for OpenAI Codex agent.

/**
 * Maps simple model aliases to full OpenAI model identifiers.
 * The frontend sends short names (e.g., "o4-mini"); this maps them
 * to the exact model string the Codex SDK expects.
 *
 * Unlike Claude which needs Bedrock/Vertex mapping, Codex models
 * are used directly — this mostly serves as a validation/default layer.
 */
const MODEL_MAPPINGS: Record<string, string> = {
  "o4-mini": "o4-mini",
  o3: "o3",
  "gpt-4.1": "gpt-4.1",
  "gpt-4.1-mini": "gpt-4.1-mini",
  "gpt-4.1-nano": "gpt-4.1-nano",
};

const DEFAULT_MODEL = "o4-mini";

/**
 * Resolves a model name for the Codex SDK.
 * Returns the input if it's already a valid model, or the default.
 */
export function resolveCodexModel(model: string | undefined): string {
  if (!model) return DEFAULT_MODEL;
  return MODEL_MAPPINGS[model] ?? model;
}
