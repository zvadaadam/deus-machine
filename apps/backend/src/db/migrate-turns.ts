import type Database from "better-sqlite3";
import type { SessionTurn } from "@shared/types/session";
import { saveTurn } from "./turns";

/** One-time move of existing history; current readers never use message accounting. */
export function migrateMessageTurns(db: Database.Database): void {
  const columns = new Set(
    (db.pragma("table_info(messages)") as { name: string }[]).map((c) => c.name)
  );
  if (!columns.has("tokens") || columns.has("content")) return;

  db.transaction(() => {
    const records = new Map<string, { sessionId: string; turn: SessionTurn }>();
    const rows = db
      .prepare(
        `SELECT session_id, turn_id, id, role, parent_tool_call_id,
      sent_at, cancelled_at, tokens, cost, turn_stop_reason,
      ${columns.has("turn_attribution") ? "turn_attribution" : "NULL AS turn_attribution"}
      FROM messages WHERE turn_id IS NOT NULL ORDER BY session_id, seq`
      )
      .all() as Array<{
      session_id: string;
      turn_id: string;
      id: string;
      role: string;
      parent_tool_call_id: string | null;
      sent_at: string | null;
      cancelled_at: string | null;
      tokens: string | null;
      cost: number | null;
      turn_stop_reason: SessionTurn["stopReason"] | null;
      turn_attribution: string | null;
    }>;
    for (const row of rows) {
      if (row.parent_tool_call_id) continue;
      const key = JSON.stringify([row.session_id, row.turn_id]);
      let record = records.get(key);
      if (!record) {
        record = { sessionId: row.session_id, turn: { turnId: row.turn_id } };
        records.set(key, record);
      }
      const turn = record.turn;
      if (row.role === "user") {
        if (row.sent_at) turn.startedAt ??= Date.parse(row.sent_at);
        continue;
      }
      if (row.tokens !== null) turn.tokens = JSON.parse(row.tokens);
      if (row.cost !== null) turn.cost = row.cost;
      if (row.turn_stop_reason !== null) turn.stopReason = row.turn_stop_reason;
      // Only cancellation and the old empty-outcome marker stored a terminal
      // timestamp. Do not invent a completion time from an ordinary message.
      const endedAt =
        row.cancelled_at ?? (row.id === `cancelled-${row.turn_id}` ? row.sent_at : null);
      if (endedAt) turn.endedAt = Date.parse(endedAt);
      if (row.cancelled_at) turn.stopReason ??= "cancelled";
      if (row.turn_attribution) {
        const source = JSON.parse(row.turn_attribution);
        if (source.execution) turn.execution = source.execution;
        const account =
          "providerCredentialSource" in source
            ? source.providerCredentialSource
            : source.credentialSource;
        if (account) turn.providerCredentialSource = account;
      }
    }
    for (const { sessionId, turn } of records.values()) saveTurn(db, sessionId, turn);

    db.exec(`DELETE FROM messages WHERE role = 'assistant' AND id = 'cancelled-' || turn_id
      AND NOT EXISTS (SELECT 1 FROM parts WHERE message_id = messages.id)`);
    for (const column of [
      "tokens",
      "cost",
      "turn_stop_reason",
      "cancelled_at",
      "turn_attribution",
    ]) {
      if (columns.has(column)) db.exec(`ALTER TABLE messages DROP COLUMN ${column}`);
    }
  })();
}
