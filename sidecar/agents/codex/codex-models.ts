// sidecar/agents/codex/codex-models.ts
// Model name resolution for OpenAI Codex agent.

const DEFAULT_MODEL = "o4-mini";

/**
 * Resolves a model name for the Codex SDK.
 * Returns the input unchanged if provided, or the default ("o4-mini").
 * Unlike Claude (which needs Bedrock/Vertex remapping), Codex model
 * names are passed through directly to the SDK.
 */
export function resolveCodexModel(model: string | undefined): string {
  return model || DEFAULT_MODEL;
}
