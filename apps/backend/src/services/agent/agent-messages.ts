import { getDatabase } from "../../lib/database";
import { invalidate } from "../query-engine";
import { getSetting } from "../settings.service";

/** A resumed harness keeps its original instructions and must find the same tools. */
export function hasAgentMessages(sessionId: string): boolean {
  const db = getDatabase();
  const read = db.prepare<[string], { agent_messages: number | null }>(
    "SELECT agent_messages FROM sessions WHERE id = ?"
  );
  const recorded = read.get(sessionId)?.agent_messages;
  if (recorded !== null) return recorded === 1;

  const result = db
    .prepare(
      `UPDATE sessions SET agent_messages = (agent_session_id IS NULL AND ?)
       WHERE id = ? AND agent_messages IS NULL`
    )
    .run(getSetting("agent_messages") !== false ? 1 : 0, sessionId);
  if (result.changes > 0) invalidate(["session", "sessions"], { sessionIds: [sessionId] });
  // Another first ask can win the write.
  return read.get(sessionId)?.agent_messages === 1;
}
