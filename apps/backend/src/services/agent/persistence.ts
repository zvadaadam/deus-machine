import type { TurnProviderCredentialSource } from "@deus-hq/api";
// backend/src/services/agent/persistence.ts
// Database writes for the canonical @zvada/agent-server conversation.
//
// Every function here takes a value the ENGINE's fold produced — a
// `ConversationMessage`, a `Part`, a `ConversationTurn` — not an event and
// certainly not a deus dialect. `parts.data` is the engine `Part` verbatim.
// What stays deus's is the SQL: ON CONFLICT vs REPLACE, which columns each row
// owns, the COALESCE guards. That is schema knowledge, and no fold has an
// opinion about it.
//
// `persistChanges` is the entry point: the reducer says WHAT moved (addressed
// by wire ids), this says which rows that implies. Redelivery mostly folds to
// NOTHING (a replayed message.started, turn.started, turn.ended or
// message.ended reports no change), so most replay-safety is structural. The
// exception is a part SNAPSHOT: the reducer never compares snapshots, it
// upserts them, so a replayed one is reported and re-written — which is why
// the parts statement is an idempotent upsert and not an insert.
//
// All functions are synchronous (better-sqlite3 is synchronous) and never
// throw: they return a WriteResult so the caller decides whether to invalidate.

import type {
  ConversationChange,
  ConversationCompaction,
  ConversationMessage,
  ConversationState,
  ConversationTurn,
  Origin,
  Part,
  UnknownPart,
} from "@zvada/agent-server/protocol";
import { getTurn, saveTurn } from "../../db/turns";
import { setInitialTitles } from "../../db/queries";
import { isUnknownPart } from "@shared/protocol-types";
import { getDatabase } from "../../lib/database";
import { getErrorMessage } from "@shared/lib/errors";
import { ACTIVE_TURN_STATUSES, type SessionStatus } from "@shared/enums";
import {
  findConversationCompaction,
  findConversationMessage,
  turnRecord,
} from "@shared/conversation-rows";

// ============================================================================
// WriteResult
// ============================================================================

export type WriteResult<T = string> = { ok: true; value: T } | { ok: false; error: string };

function failed(what: string, error: unknown): WriteResult<never> {
  const message = getErrorMessage(error);
  console.error(`[AgentPersistence] Failed to persist ${what}:`, message);
  return { ok: false, error: message };
}

/** Epoch-ms (protocol time) → the ISO strings every timestamp column stores. */
function iso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

// ============================================================================
// Messages + parts
// ============================================================================

/**
 * Mint the row for a folded message.
 *
 * This is the ONLY writer of message rows — the user echo included. Deus does
 * not insert the user's message when the composer sends: the engine echoes it
 * back (role "user", outputIndex 0) and that echo is the persistence source of
 * truth, so a user row and an assistant row are produced by the same code path
 * with the same turn grouping.
 *
 * The upsert is ON CONFLICT, never INSERT OR REPLACE: SQLite's REPLACE is
 * DELETE + INSERT, which would cascade-delete the message's parts, reassign
 * its `seq` (AFTER INSERT trigger) to the end of the transcript, inflate
 * `message_count` (the AFTER DELETE trigger does not fire under REPLACE) and
 * wipe columns written after the message started. Within one process the fold makes a replayed
 * `message.started` report nothing, so this rarely runs twice — but after a
 * BACKEND RESTART the fold begins empty while SQLite remembers everything, and
 * the first replayed message of a resumed session lands here as a genuine
 * upsert. COALESCE guards the fields a thinner replay omits.
 */
export function persistMessage(sessionId: string, message: ConversationMessage): WriteResult {
  const result = persistMessages(sessionId, [message]);
  return result.ok ? { ok: true, value: message.messageId } : result;
}

/** One session check and prepared upsert for a snapshot's message batch. */
export function persistMessages(
  sessionId: string,
  messages: readonly ConversationMessage[]
): WriteResult<void> {
  const db = getDatabase();
  try {
    // A message for a session we don't know about has no FK target; the parts
    // that follow would fail too. Skip loudly instead of throwing per part.
    const session = db.prepare(`SELECT id FROM sessions WHERE id = ?`).get(sessionId);
    if (!session) {
      console.warn(`[AgentPersistence] message: session ${sessionId} not found, skipping`);
      return { ok: false, error: "session not found" };
    }

    const upsert = db.prepare(
      `INSERT INTO messages (id, session_id, role, turn_id, model, sent_at, parent_tool_call_id, origin, steer_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         role = excluded.role,
         turn_id = excluded.turn_id,
         model = COALESCE(excluded.model, messages.model),
         sent_at = COALESCE(excluded.sent_at, messages.sent_at),
         parent_tool_call_id = COALESCE(excluded.parent_tool_call_id, messages.parent_tool_call_id),
         origin = COALESCE(excluded.origin, messages.origin),
         steer_id = COALESCE(excluded.steer_id, messages.steer_id)`
    );
    for (const message of messages) {
      upsert.run(
        message.messageId,
        sessionId,
        message.role,
        message.turnId,
        message.model ?? null,
        iso(message.startedAt),
        message.parentToolCallId ?? null,
        // Who sent a user message, as the engine echoed it: never a client's word.
        message.role === "user" && message.origin ? JSON.stringify(message.origin) : null,
        message.role === "user" ? (message.steerId ?? null) : null
      );
    }
    return { ok: true, value: undefined };
  } catch (error) {
    return failed("message", error);
  }
}

/**
 * The tool columns, promoted out of `data` for indexed lookups. An UNKNOWN
 * part (Law 6) has no known fields to promote — it is stored verbatim and
 * queried by nothing.
 */
function toolColumns(part: Part | UnknownPart): {
  toolCallId: string | null;
  toolName: string | null;
} {
  if (isUnknownPart(part) || part.type !== "tool") return { toolCallId: null, toolName: null };
  return { toolCallId: part.toolCallId, toolName: part.toolName };
}

/**
 * What `parts.data` stores: the part as it came off the WIRE.
 *
 * For a known type the decoded value and the wire payload are the same shape,
 * so this is a no-op. For an UNKNOWN one they are not: `decodePart` wraps a
 * payload this build cannot read into `{type, id, ..., raw: <the payload>}`,
 * and that wrapper is THIS build's ignorance, not the engine's message.
 * Persisting it would freeze today's ignorance into the row — a later build
 * that LEARNS the type would load a `raw`-bearing wrapper, fail its own
 * `"raw" in part` checks and keep the content hidden forever, for a part it is
 * now perfectly able to render.
 *
 * So the row keeps the payload and `attachParts` re-derives the runtime shape
 * with `decodePart` on the way out: still-unknown re-wraps identically, and
 * newly-known decodes properly. Law 6 is "forward what you cannot read", and a
 * row that outlives the build that wrote it has to forward it to the FUTURE
 * too, not just to the frontend.
 */
function storedPartData(part: Part | UnknownPart): string {
  return JSON.stringify(isUnknownPart(part) ? part.raw : part);
}

/**
 * Upsert a part. The folded part is authoritative and idempotent (UPSERT by
 * part id), so INSERT OR REPLACE is the exact match for its semantics —
 * including a tool part completing after its message ended, which names its
 * ORIGINAL messageId and lands back there, and a cancelled turn's closure
 * rewriting a still-open tool. Unlike `messages`, a `parts` row owns every one
 * of its columns, so REPLACE has nothing to lose and nothing cascades off it.
 *
 * `seq` mirrors the change's `partIndex`: parts carry no ordering field of
 * their own, position is the stream's knowledge.
 *
 * `data` holds the WIRE part — see `storedPartData`.
 */
export function persistPart(
  sessionId: string,
  messageId: string,
  part: Part | UnknownPart,
  partIndex: number
): WriteResult {
  const db = getDatabase();
  try {
    const tool = toolColumns(part);
    db.prepare(
      `INSERT OR REPLACE INTO parts (id, message_id, session_id, seq, type, data, tool_call_id, tool_name, parent_tool_call_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      part.id,
      messageId,
      sessionId,
      partIndex,
      part.type,
      storedPartData(part),
      tool.toolCallId,
      tool.toolName,
      part.parentToolCallId ?? null
    );
    return { ok: true, value: part.id };
  } catch (error) {
    const message = getErrorMessage(error);
    // A part can outrun its message row (the session lookup above rejected it,
    // or the events crossed). The next snapshot re-upserts, so this is not a
    // data loss worth shouting about.
    if (message.includes("FOREIGN KEY")) {
      return { ok: true, value: part.id };
    }
    return failed("part", error);
  }
}

// ============================================================================
// Turn outcome
// ============================================================================

export interface TurnOutcomeWrite {
  /** Session status to leave behind. */
  status: "idle" | "error";
  /** Set when status is "error". */
  error?: { message: string; category: string };
}

// A Stop never creates a turn row. Its answer can only correct one the engine or release wrote.
export function persistStopCredit(id: string, turnId: string, by?: Origin) {
  try {
    getDatabase()
      .prepare("UPDATE turns SET cancelled_by = ? WHERE session_id = ? AND turn_id = ?")
      .run(by ? JSON.stringify(by) : null, id, turnId);
  } catch (error) {
    failed("Stop credit", error);
  }
}

/** A lost link can leave a row active. A warning on a live turn keeps its card available. */
export function persistStopStatus(id: string, status: "idle" | "error" | null = "idle") {
  try {
    const warning = status === "idle" ? null : "The agent never confirmed the stop request.";
    const { changes } = getDatabase()
      .prepare(
        `UPDATE sessions SET status = COALESCE(?, status), error_message = COALESCE(error_message, ?),
       error_category = COALESCE(error_category, ?), updated_at = datetime('now')
     WHERE id = ? AND status IN (${ACTIVE_TURN_STATUSES.map(() => "?").join(", ")})`
      )
      .run(status, warning, warning && "internal", id, ...ACTIVE_TURN_STATUSES);
    return changes > 0;
  } catch (error) {
    failed("Stop status", error);
    return false;
  }
}

/** Persist a turn and its optional session status atomically, even without messages. */
export function persistTurn(
  sessionId: string,
  turn: Parameters<typeof turnRecord>[0] & { cancelledBy?: Origin },
  outcome?: TurnOutcomeWrite,
  providerCredentialSource?: TurnProviderCredentialSource
): WriteResult<void> {
  const db = getDatabase();
  try {
    db.transaction(() => {
      const prior = getTurn(db, sessionId, turn.turnId);
      const record = turnRecord(turn, providerCredentialSource, prior);
      saveTurn(db, sessionId, { ...record, cancelledBy: turn.cancelledBy });
      if (outcome) writeStatus(sessionId, terminalStatus(outcome));
    })();
    return { ok: true, value: undefined };
  } catch (error) {
    return failed("turn", error);
  }
}

// ============================================================================
// Session state
// ============================================================================

export type SessionProjection = readonly [
  SessionStatus,
  message?: string | null,
  category?: string | null,
];

export function terminalStatus(
  { status, error }: TurnOutcomeWrite,
  prior?: SessionProjection
): SessionProjection {
  if (prior && status === "error" && !error)
    return [status, prior[1] ?? "Agent turn failed", prior[2] ?? "internal"];
  return [status, error?.message, error?.category];
}

// A terminal without ErrorInfo keeps the standalone error the engine already reported.
function writeStatus(id: string, [status, message, category]: SessionProjection) {
  const reported = status === "error" && message === undefined && category === undefined;
  getDatabase()
    .prepare(
      `UPDATE sessions SET status = @status,
       error_message = CASE WHEN @reported THEN COALESCE(error_message, 'Agent turn failed') ELSE @message END,
       error_category = CASE WHEN @reported THEN COALESCE(error_category, 'internal') ELSE @category END,
       updated_at = datetime('now') WHERE id = @id`
    )
    .run({ id, status, message, category, reported: Number(reported) });
}

export function persistSessionStatus(id: string, ...state: SessionProjection): WriteResult<void> {
  try {
    writeStatus(id, state);
    return { ok: true, value: undefined };
  } catch (error) {
    return failed("session status", error);
  }
}

/** A first task can fail after a different turn has already used the chat. */
export function persistUndeliveredFirstTask(id: string, turnId: string, message: string) {
  try {
    getDatabase()
      .prepare(
        `UPDATE sessions SET status = 'error', error_message = ? WHERE id = ? AND message_count = 0
       AND NOT EXISTS (SELECT 1 FROM turns WHERE session_id = sessions.id AND turn_id != ?)`
      )
      .run(message, id, turnId);
    return true;
  } catch (error) {
    failed("undelivered first task", error);
    return false;
  }
}

/** Only an admitted send orders the sidebar and protects a prompted checkout from cleanup. */
export function persistLastUserMessageAt(sessionId: string, sentAt: string): WriteResult<void> {
  const db = getDatabase();
  try {
    db.prepare(
      `UPDATE sessions SET last_user_message_at = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(sentAt, sessionId);
    return { ok: true, value: undefined };
  } catch (error) {
    return failed("last_user_message_at", error);
  }
}

/** Update session status to "needs_plan_response" when agent requests plan approval. */
export function persistSessionNeedsPlanResponse(sessionId: string): WriteResult<void> {
  const db = getDatabase();
  try {
    db.prepare(
      `UPDATE sessions SET status = 'needs_plan_response', updated_at = datetime('now') WHERE id = ?`
    ).run(sessionId);
    return { ok: true, value: undefined };
  } catch (error) {
    return failed("needs_plan_response", error);
  }
}

/** Update session status to "needs_response" when agent asks user a question. */
export function persistSessionNeedsResponse(sessionId: string): WriteResult<void> {
  const db = getDatabase();
  try {
    db.prepare(
      `UPDATE sessions SET status = 'needs_response', updated_at = datetime('now') WHERE id = ?`
    ).run(sessionId);
    return { ok: true, value: undefined };
  } catch (error) {
    return failed("needs_response", error);
  }
}

/** Restore session status to "working" when a pending request is resolved. */
export function persistSessionBackToWorking(sessionId: string): WriteResult<void> {
  const db = getDatabase();
  try {
    db.prepare(
      `UPDATE sessions SET status = 'working', updated_at = datetime('now')
       WHERE id = ? AND status IN ('needs_plan_response', 'needs_response')`
    ).run(sessionId);
    return { ok: true, value: undefined };
  } catch (error) {
    return failed("working status", error);
  }
}

/** Persist the live context gauge onto the session row (composer indicator). */
export function persistSessionUsage(
  sessionId: string,
  usage: NonNullable<ConversationState["usage"]>
): WriteResult<void> {
  const db = getDatabase();
  try {
    // Claude reports `used` on every model message but `size` only on the
    // final result. The FOLD is the
    // sticky merge now — `usage.size` is the last size it saw this process.
    //
    // The COALESCE stays, for a case the fold cannot cover: after a backend
    // restart the fold begins empty, so the first size-less usage event of a
    // resumed session would zero a percent the DB still knows. In-memory
    // stickiness is per-process; the column's is durable.
    const percent = usage.size ? Math.min((usage.used / usage.size) * 100, 100) : null;
    db.prepare(
      `UPDATE sessions
         SET context_token_count = ?, context_used_percent = COALESCE(?, context_used_percent),
             updated_at = datetime('now')
       WHERE id = ?`
    ).run(usage.used, percent, sessionId);
    return { ok: true, value: undefined };
  } catch (error) {
    return failed("session.usage", error);
  }
}

/**
 * Settle the local chats a previous process left mid-turn. Called once, as the
 * engine starts.
 *
 * The engine runs in this process and keeps its turns in memory (Deus opens it
 * with no journal), so a backend that was killed or crashed took its turns and
 * the agent CLIs it ran with it. Nothing will ever end them: no `turn.ended`
 * arrives, the new engine answers a cancel with `no_active_turn`, and until
 * someone pressed Stop every send, wait and answer was refused against a
 * status that claimed a turn. A fresh engine has no turn at all, so every
 * local chat still marked working or waiting is settled as an error that says
 * what happened (the agent may have changed files before it stopped).
 *
 * Cloud chats are left alone: their turn runs in a sandbox and may really
 * still be running. What the platform says decides them (the cloud lane), not
 * a restart of this process.
 */
export function settleInterruptedSessions(): WriteResult<string[]> {
  const db = getDatabase();
  const active = ACTIVE_TURN_STATUSES.map(() => "?").join(", ");
  try {
    const ids = (
      db
        .prepare(
          `SELECT s.id FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
           WHERE s.status IN (${active}) AND w.kind != 'cloud'`
        )
        .all(...ACTIVE_TURN_STATUSES) as { id: string }[]
    ).map((row) => row.id);
    if (ids.length > 0) {
      db.prepare(
        `UPDATE sessions
           SET status = 'error', error_message = ?, error_category = 'internal',
               updated_at = datetime('now')
         WHERE id IN (SELECT value FROM json_each(?))`
      ).run(
        "Deus quit while the agent was working, so this turn did not finish. Check what it changed, then send again.",
        JSON.stringify(ids)
      );
    }
    // Every local turn that never ended ends now, as failed, not only those of the
    // chats just settled: no local turn survives the process, and an unended turn
    // row would hold every read cursor at its first message.
    db.prepare(
      `UPDATE turns SET ended_at = ?, outcome = ?
       WHERE ended_at IS NULL AND session_id IN (SELECT s.id FROM sessions s JOIN workspaces w ON w.id = s.workspace_id WHERE w.kind != 'cloud')`
    ).run(
      Date.now(),
      JSON.stringify({ stopReason: "error", error: { message: "Deus quit mid-turn." } })
    );
    return { ok: true, value: ids };
  } catch (error) {
    return failed("interrupted sessions", error);
  }
}

// ============================================================================
// Metadata
// ============================================================================

/** Store the harness-native session id so the next turn can resume it. */
export function persistAgentSessionId(
  sessionId: string,
  nativeSessionId: string
): WriteResult<void> {
  const db = getDatabase();
  try {
    db.prepare(
      `UPDATE sessions SET agent_session_id = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(nativeSessionId, sessionId);
    return { ok: true, value: undefined };
  } catch (error) {
    return failed("session.created", error);
  }
}

export function persistSessionTitle(sessionId: string, title: string): WriteResult<void> {
  try {
    setInitialTitles(getDatabase(), sessionId, title, "summary");
    return { ok: true, value: undefined };
  } catch (error) {
    return failed("session title", error);
  }
}

/**
 * Upsert the compaction entity. It is ID-addressed and positional: the first
 * event anchors it (created_at), later upserts advance status/summary/tokens
 * without moving it, so the divider keeps its place in a replayed transcript.
 */
export function persistCompaction(
  sessionId: string,
  compaction: ConversationCompaction
): WriteResult {
  const db = getDatabase();
  try {
    db.prepare(
      `INSERT INTO compactions (compaction_id, session_id, turn_id, status, trigger, pre_tokens, post_tokens, summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(compaction_id) DO UPDATE SET
         status = excluded.status,
         trigger = COALESCE(excluded.trigger, compactions.trigger),
         pre_tokens = COALESCE(excluded.pre_tokens, compactions.pre_tokens),
         post_tokens = COALESCE(excluded.post_tokens, compactions.post_tokens),
         summary = COALESCE(excluded.summary, compactions.summary)`
    ).run(
      compaction.compactionId,
      sessionId,
      compaction.turnId,
      compaction.status,
      compaction.trigger ?? null,
      compaction.preTokens ?? null,
      compaction.postTokens ?? null,
      compaction.summary ?? null,
      iso(compaction.timestamp)
    );
    return { ok: true, value: compaction.compactionId };
  } catch (error) {
    return failed("session.compaction", error);
  }
}

// ============================================================================
// The change loop
// ============================================================================

/**
 * One row write the fold's changes implied, for a caller that logs or counts.
 *
 * The change is handed back whole rather than pre-formatted: the shipped
 * handler keys off `change.kind`, and the verification CLI writes its own log
 * label from the typed change. A pre-rendered `detail` string used to be built
 * on every production write — per part, on the WS hot path — for that one CLI
 * line.
 */
export interface ChangeWrite {
  change: ConversationChange;
  result: WriteResult<unknown>;
}

/**
 * Turn the reducer's changes into row writes.
 *
 * The `changes` say what moved and address it by wire id; `state` holds the
 * values. Everything not listed here is deliberately not a row: a bracket
 * marker (`message-ended`), streamed tool input (`delta-buffered` — the
 * snapshot that follows is what gets stored), permissions (deus answers them
 * in-process and has no prompt to render), and the session-scoped facts the
 * caller writes itself because they carry product state (`session-meta-updated`
 * → agent_session_id, `session-ended`).
 *
 * `outcomeFor` is the caller's: an ended turn's terminal state depends on
 * whether deus already reported an error for it, which is session bookkeeping
 * the fold has no opinion about.
 */
export function persistChanges(
  sessionId: string,
  state: ConversationState,
  changes: ConversationChange[],
  outcomeFor: (turn: ConversationTurn) => TurnOutcomeWrite | undefined,
  providerCredentialSource?: TurnProviderCredentialSource,
  cancelledBy?: Origin
): ChangeWrite[] {
  const writes: ChangeWrite[] = [];
  for (const change of changes) {
    switch (change.kind) {
      case "message_upserted": {
        const message = findConversationMessage(state, change.messageId);
        if (!message) break;
        writes.push({ change, result: persistMessage(sessionId, message) });
        break;
      }
      case "part_upserted": {
        const message = findConversationMessage(state, change.messageId);
        const part = message?.parts.find((p) => p.id === change.partId);
        if (!part) break;
        writes.push({
          change,
          result: persistPart(sessionId, change.messageId, part, change.partIndex),
        });
        break;
      }
      case "turn_updated": {
        const turn = state.turns.find((t) => t.turnId === change.turnId);
        if (!turn) break;
        writes.push({
          change,
          result: persistTurn(
            sessionId,
            { ...turn, cancelledBy },
            turn.status === "ended" ? outcomeFor(turn) : undefined,
            providerCredentialSource
          ),
        });
        break;
      }
      case "usage_updated": {
        // Also emitted when an ended turn's billing rolls into the totals,
        // which moves no session column.
        if (!state.usage) break;
        writes.push({ change, result: persistSessionUsage(sessionId, state.usage) });
        break;
      }
      case "compaction_upserted": {
        const entry = findConversationCompaction(state, change.compactionId);
        if (!entry) break;
        writes.push({ change, result: persistCompaction(sessionId, entry) });
        break;
      }
      default:
        break;
    }
  }
  return writes;
}
