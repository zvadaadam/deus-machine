import type { SessionSnapshotEvent } from "@deus-hq/api";
import { emptyConversation, reduceConversationWithChanges } from "@zvada/agent-server/protocol";
import {
  projectCloudSnapshot,
  type RestoredCloudConversation,
} from "@shared/cloud-session-snapshot";
import { cancelledTurnMessageId } from "@shared/types/session";
import { supersededCancellationMarkers } from "@shared/conversation-rows";
import { getErrorMessage } from "@shared/lib/errors";
import { getDatabase } from "../../../lib/database";
import {
  persistCompaction,
  persistMessages,
  persistPart,
  persistTurnEnded,
  type WriteResult,
} from "../persistence";

/** Restore the cloud's durable transcript without replaying live turn effects. */
export function restoreCloudSnapshot(
  sessionId: string,
  snapshot: SessionSnapshotEvent,
  preserveStatus: boolean
): WriteResult<RestoredCloudConversation> {
  const { events, messageIds } = projectCloudSnapshot(snapshot);
  let conversation = emptyConversation();
  for (const event of events) {
    conversation = reduceConversationWithChanges(conversation, { ...event, sessionId }).state;
  }
  const db = getDatabase();
  const requireWrite = (result: WriteResult<unknown>) => {
    if (!result.ok) throw new Error(result.error);
  };
  try {
    const orderedIds = db.transaction(() => {
      const lastTurn = conversation.turns.at(-1);
      // A session.error can have supplied better details after this terminal.
      // Keep them when reconnecting to a failure already persisted locally.
      const knownFailure =
        lastTurn &&
        db
          .prepare(
            "SELECT 1 FROM messages WHERE session_id = ? AND turn_id = ? AND turn_stop_reason = 'error' LIMIT 1"
          )
          .get(sessionId, lastTurn.turnId);
      requireWrite(
        persistMessages(
          sessionId,
          conversation.timeline.filter((entry) => entry.kind === "message")
        )
      );
      for (const entry of conversation.timeline) {
        if (entry.kind === "compaction") {
          requireWrite(persistCompaction(sessionId, entry));
        } else {
          entry.parts.forEach((part, index) =>
            requireWrite(persistPart(sessionId, entry.messageId, part, index))
          );
        }
      }

      const markers = supersededCancellationMarkers(conversation);
      if (markers.size) {
        db.prepare(
          "DELETE FROM messages WHERE session_id = ? AND id IN (SELECT value FROM json_each(?))"
        ).run(sessionId, JSON.stringify([...markers]));
      }

      // A missed older message must not append behind later rows already in
      // SQLite. Keep local-only rows, including a prompt awaiting admission.
      const rows = db
        .prepare("SELECT id, seq, turn_id FROM messages WHERE session_id = ? ORDER BY seq")
        .all(sessionId) as { id: string; seq: number; turn_id: string | null }[];
      const rank = new Map(messageIds.map((id, index) => [id, index]));
      const updateOrder = db.prepare("UPDATE messages SET seq = ? WHERE id = ? AND session_id = ?");
      rows.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
      rows.forEach((row, index) => {
        if (row.seq !== index + 1) updateOrder.run(index + 1, row.id, sessionId);
      });

      // Accounting lands on the actual last assistant message after ordering.
      for (const turn of conversation.turns) {
        if (turn.status === "ended") requireWrite(persistTurnEnded(sessionId, turn));
      }

      // Cancellation without assistant output creates a marker. Anchor it to
      // that turn's user message, rather than the end of the restored history.
      const ordered = db
        .prepare("SELECT id, seq, turn_id FROM messages WHERE session_id = ? ORDER BY seq")
        .all(sessionId) as typeof rows;
      const lastInTurn = new Map<string, number>();
      for (const row of ordered) {
        if (row.turn_id && rank.has(row.id)) lastInTurn.set(row.turn_id, rank.get(row.id)!);
      }
      for (const row of ordered) {
        if (row.turn_id && row.id === cancelledTurnMessageId(row.turn_id)) {
          const anchor = lastInTurn.get(row.turn_id);
          if (anchor !== undefined) rank.set(row.id, anchor + 0.5);
        }
      }
      ordered.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
      ordered.forEach((row, index) => {
        if (row.seq !== index + 1) updateOrder.run(index + 1, row.id, sessionId);
      });

      const currentTurnId = snapshot.state.currentTurnId;
      const status = currentTurnId
        ? "working"
        : snapshot.state.status === "error"
          ? "error"
          : "idle";
      const userTimes = (snapshot.messages ?? [])
        .filter((message) => message.role === "user")
        .map((message) => message.createdAt);
      const lastUserAt = userTimes.length
        ? new Date(userTimes.reduce((a, b) => Math.max(a, b))).toISOString()
        : null;
      db.prepare(
        `UPDATE sessions SET
           status = CASE WHEN ? THEN status ELSE ? END,
           error_message = CASE WHEN ? OR (? AND status = 'error') THEN error_message ELSE ? END,
           error_category = CASE WHEN ? OR (? AND status = 'error') THEN error_category ELSE ? END,
           last_user_message_at = COALESCE(MAX(last_user_message_at, ?), last_user_message_at, ?),
           context_token_count = COALESCE(?, context_token_count),
           context_used_percent = COALESCE(?, context_used_percent)
         WHERE id = ?`
      ).run(
        Number(preserveStatus),
        status,
        Number(preserveStatus),
        Number(Boolean(knownFailure) && status === "error"),
        status === "error" ? (lastTurn?.error?.message ?? "Agent turn failed") : null,
        Number(preserveStatus),
        Number(Boolean(knownFailure) && status === "error"),
        status === "error" ? (lastTurn?.error?.category ?? "internal") : null,
        lastUserAt,
        lastUserAt,
        snapshot.state.contextUsed ?? null,
        snapshot.state.contextUsed != null && snapshot.state.contextSize
          ? Math.min(100, (snapshot.state.contextUsed / snapshot.state.contextSize) * 100)
          : null,
        sessionId
      );
      return ordered.map((row) => row.id);
    })();
    return { ok: true, value: { conversation, messageIds: orderedIds } };
  } catch (error) {
    return { ok: false, error: getErrorMessage(error) };
  }
}
