import { ThinkingLevelSchema, type ThinkingLevel } from "@shared/protocol";

export type { ThinkingLevel } from "@shared/protocol";

export function parseThinkingLevel(
  thinkingLevel: unknown,
  agentLabel: string
): ThinkingLevel | undefined {
  if (thinkingLevel === undefined || thinkingLevel === null || thinkingLevel === "") {
    return undefined;
  }

  const parsed = ThinkingLevelSchema.safeParse(thinkingLevel);
  if (parsed.success) return parsed.data;

  throw new Error(`Unsupported ${agentLabel} thinking level: ${String(thinkingLevel)}`);
}
