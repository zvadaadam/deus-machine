import { getSetting } from "../settings.service";

const messagesBySession = new Map<string, boolean>();

/** Opening a chat reads the tool list decision only if the agent has already asked. */
export function recordedAgentMessages(sessionId: string): boolean {
  return messagesBySession.get(sessionId) === true;
}

/** A harness keeps its first tool list. Every turn's instructions must match that list. */
export function hasAgentMessages(sessionId: string): boolean {
  const previous = messagesBySession.get(sessionId);
  if (previous !== undefined) return previous;
  const enabled = getSetting("agent_messages") === true;
  messagesBySession.set(sessionId, enabled);
  return enabled;
}
