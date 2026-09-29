export function lookupAgentLogo<T>(
  agentLogos: Record<string, T>,
  agentHarness: string | null | undefined
): T | undefined {
  if (!agentHarness) return undefined;
  return agentLogos[agentHarness.toLowerCase()];
}
