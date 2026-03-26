// agent-server/agents/claude/claude-models.ts
// Model name mapping for Bedrock and Vertex providers.

const BEDROCK_MAPPINGS: Record<string, string> = {
  opus: "global.anthropic.claude-opus-4-5-20251101-v1:0",
  sonnet: "global.anthropic.claude-sonnet-4-6-20260217-v1:0",
  haiku: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
};

const VERTEX_MAPPINGS: Record<string, string> = {
  opus: "claude-opus-4-5@20251101",
  sonnet: "claude-sonnet-4-6@20260217",
  haiku: "claude-haiku-4-5@20251001",
};

/**
 * Maps simple model names (opus, sonnet, haiku) to provider-specific
 * model identifiers for Bedrock or Vertex. Returns the input unchanged
 * when no provider env var is set or the model isn't in the mapping.
 */
export function mapModelForProvider(
  simpleModel: string | undefined,
  envVars: Record<string, string>
): string | undefined {
  if (!simpleModel) return undefined;

  if (envVars.CLAUDE_CODE_USE_BEDROCK === "1") {
    return BEDROCK_MAPPINGS[simpleModel] ?? simpleModel;
  }
  if (envVars.CLAUDE_CODE_USE_VERTEX === "1") {
    return VERTEX_MAPPINGS[simpleModel] ?? simpleModel;
  }

  return simpleModel;
}
