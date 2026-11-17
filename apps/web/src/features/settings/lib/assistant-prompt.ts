/**
 * What a person gives an assistant (or an agent that can add a connector
 * itself) so it connects to this computer. The dialog shows it as the first
 * step and copies it. Plain text: it is read by a model, and shown as typed.
 */
export function assistantPrompt(address: string, computerName?: string | null): string {
  const name = computerName?.trim();
  const computer = name ? `my Deus computer "${name}"` : "my Deus computer";
  return [
    `Connect to ${computer} so you can work with my coding sessions.`,
    `Add this address as a custom connector named "Deus Machine" (a remote MCP server with OAuth sign-in): ${address}`,
    "I will sign in with my Deus account when it asks, then allow you on the computer. After that you can add a project from a git address, list, read and start sessions, send them messages, wait for results and answer their questions. Start by listing my sessions.",
  ].join("\n\n");
}
