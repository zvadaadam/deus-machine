import type { SessionSnapshotEvent } from "@deus-hq/api";
import { emptyConversation, reduceConversationWithChanges } from "@zvada/agent-server/protocol";
import {
  projectCloudSnapshot,
  type RestoredCloudConversation,
} from "@shared/cloud-session-snapshot";
import { getTurn } from "../../../db/turns";
import { getErrorMessage } from "@shared/lib/errors";
import { getDatabase } from "../../../lib/database";
import {
  persistCompaction,
  persistMessages,
  persistPart,
  persistTurn,
  type WriteResult,
} from "../persistence";

/** Restore the cloud's durable transcript without replaying live turn effects. */
export function restoreCloudSnapshot(
  sessionId: string,
  snapshot: SessionSnapshotEvent,
  preserveStatus: boolean
): WriteResult<RestoredCloudConversation> {
  const { events, messageIds } = projectCloudSnapshot(snapshot);
  const providerCredentialSources = Object.fromEntries(
    (snapshot.state.turns ?? []).flatMap((turn) =>
      turn.providerCredentialSource ? [[turn.turnId, turn.providerCredentialSource]] : []
    )
  );
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
        lastTurn && getTurn(db, sessionId, lastTurn.turnId)?.stopReason === "error";
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

      // A missed older message must not append behind later rows already in
      // SQLite. Keep local-only rows, including a prompt awaiting admission.
      const rows = db
        .prepare("SELECT id, seq FROM messages WHERE session_id = ? ORDER BY seq")
        .all(sessionId) as { id: string; seq: number }[];
      const rank = new Map(messageIds.map((id, index) => [id, index]));
      const updateOrder = db.prepare("UPDATE messages SET seq = ? WHERE id = ? AND session_id = ?");
      rows.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
      rows.forEach((row, index) => {
        if (row.seq !== index + 1) updateOrder.run(index + 1, row.id, sessionId);
      });

      for (const turn of conversation.turns) {
        requireWrite(
          persistTurn(sessionId, turn, undefined, providerCredentialSources[turn.turnId])
        );
      }

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
      return rows.map((row) => row.id);
    })();
    return { ok: true, value: { conversation, messageIds: orderedIds, providerCredentialSources } };
  } catch (error) {
    return { ok: false, error: getErrorMessage(error) };
  }
}
