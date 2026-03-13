// sidecar/agents/codex/codex-models.ts
// Model name resolution for OpenAI Codex agent.

const DEFAULT_MODEL = "gpt-5.4";

/**
 * Resolves a model name for the Codex SDK.
 * Returns the input unchanged if provided, or the default ("gpt-5.4").
 * Unlike Claude (which needs Bedrock/Vertex remapping), Codex model
 * names are passed through directly to the SDK.
 */
export function resolveCodexModel(model: string | undefined): string {
  return model ?? DEFAULT_MODEL;
}
