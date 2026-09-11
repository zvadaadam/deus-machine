import type Database from "better-sqlite3";
import type { SessionTurn } from "@shared/types/session";

interface TurnRow {
  turn_id: string;
  started_at: number | null;
  ended_at: number | null;
  execution: string | null;
  provider_credential_source: string | null;
  outcome: string | null;
  tokens: string | null;
  cost: number | null;
}

function decodeTurn(row: TurnRow): SessionTurn {
  return {
    turnId: row.turn_id,
    ...(row.started_at !== null && { startedAt: row.started_at }),
    ...(row.ended_at !== null && { endedAt: row.ended_at }),
    ...(row.execution && { execution: JSON.parse(row.execution) }),
    ...(row.provider_credential_source && {
      providerCredentialSource: JSON.parse(row.provider_credential_source),
    }),
    ...(row.outcome && JSON.parse(row.outcome)),
    ...(row.tokens && { tokens: JSON.parse(row.tokens) }),
    ...(row.cost !== null && { cost: row.cost }),
  };
}

export function getTurn(
  db: Database.Database,
  sessionId: string,
  turnId: string
): SessionTurn | undefined {
  const row = db
    .prepare("SELECT * FROM turns WHERE session_id = ? AND turn_id = ?")
    .get(sessionId, turnId) as TurnRow | undefined;
  return row && decodeTurn(row);
}

/** Page-associated turns plus outcomes that have no message at all. A turn whose
 * messages are paginated away must not appear as an empty response. */
export function getTurnsForMessages(
  db: Database.Database,
  sessionId: string,
  messages: readonly { turn_id?: string | null }[]
): SessionTurn[] {
  const turnIds = [...new Set(messages.flatMap((m) => (m.turn_id ? [m.turn_id] : [])))];
  const rows = db
    .prepare(
      `
    SELECT * FROM turns AS t WHERE session_id = ? AND (
      turn_id IN (SELECT value FROM json_each(?)) OR NOT EXISTS (
        SELECT 1 FROM messages AS m WHERE m.session_id = t.session_id AND m.turn_id = t.turn_id
      )
    ) ORDER BY COALESCE(started_at, ended_at), turn_id
  `
    )
    .all(sessionId, JSON.stringify(turnIds)) as TurnRow[];
  return rows.map(decodeTurn);
}

/** Replaces one already-merged record; accounting is never summed on write. */
export function saveTurn(db: Database.Database, sessionId: string, turn: SessionTurn): void {
  const json = (value: unknown) => (value === undefined ? null : JSON.stringify(value));
  db.prepare(
    `
    INSERT INTO turns (session_id, turn_id, started_at, ended_at, execution,
      provider_credential_source, outcome, tokens, cost)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, turn_id) DO UPDATE SET
      started_at = excluded.started_at, ended_at = excluded.ended_at,
      execution = excluded.execution, provider_credential_source = excluded.provider_credential_source,
      outcome = excluded.outcome, tokens = excluded.tokens, cost = excluded.cost
  `
  ).run(
    sessionId,
    turn.turnId,
    turn.startedAt ?? null,
    turn.endedAt ?? null,
    json(turn.execution),
    json(turn.providerCredentialSource),
    json(
      turn.stopReason === undefined
        ? undefined
        : {
            stopReason: turn.stopReason,
            finishReason: turn.finishReason,
            error: turn.error,
          }
    ),
    json(turn.tokens),
    turn.cost ?? null
  );
}
