// Who is a coordinator: a chat's board-tools pin and its coordinator workspace's state.
import { getDatabase } from "../../lib/database";

/**
 * The one rule for a chat's board tools: pinned on, or not pinned yet and still without an
 * agent conversation, so its first turn pins them on. Over a `sessions` row. The pin also
 * checks the workspace is a coordinator; a board delivery already chose a board's workspace.
 */
export const HAS_OR_WILL_PIN_BOARD_TOOLS =
  "(board_tools = 1 OR (board_tools IS NULL AND agent_session_id IS NULL))";

/**
 * This chat's board-tools pin, written on its first use: a resumed conversation must find the
 * same tools it started with, including chats from older builds.
 */
export function pinBoardTools(sessionId: string): boolean {
  const db = getDatabase();
  const read = db.prepare<[string], { board_tools: number | null }>(
    "SELECT board_tools FROM sessions WHERE id = ?"
  );
  let pin = read.get(sessionId)?.board_tools;
  if (pin === null) {
    db.prepare(
      `UPDATE sessions SET board_tools = CASE WHEN ${HAS_OR_WILL_PIN_BOARD_TOOLS} AND EXISTS (
        SELECT 1 FROM workspaces WHERE id = sessions.workspace_id AND role = 'coordinator'
      ) THEN 1 ELSE 0 END WHERE id = ? AND board_tools IS NULL`
    ).run(sessionId);
    pin = read.get(sessionId)?.board_tools;
  }
  return pin === 1;
}

/** A coordinator chat's workspace state: its board tools pinned, the chat not hidden. */
export function coordinatorState(sessionId: string) {
  return getDatabase()
    .prepare<[string], { state: string }>(
      `SELECT w.state FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
       WHERE s.id = ? AND NOT s.is_hidden AND s.board_tools = 1 AND w.role = 'coordinator'`
    )
    .get(sessionId)?.state;
}
