/**
 * Unit tests for the persistence layer, against a REAL in-memory SQLite with
 * the full schema applied — the writes are SQL, so mocking the database would
 * only pin the strings, not the behaviour (COALESCE merges, ON CONFLICT
 * upserts, FK guards, triggers).
 *
 * Every function here takes an engine event verbatim: there is no deus dialect
 * between the wire and the row.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MessagePartEvent,
  MessageStartedEvent,
  SessionCompactionEvent,
  SessionUsageEvent,
  TurnEndedEvent,
} from "@zvada/agent-server/protocol";

// better-sqlite3 may be compiled for Electron's Node ABI — skip if unavailable
let canUseDatabase = true;
try {
  new Database(":memory:").close();
} catch {
  canUseDatabase = false;
}
const describeWithDb = canUseDatabase ? describe : describe.skip;

import { SCHEMA_SQL } from "@shared/schema";

const { mockGetDatabase } = vi.hoisted(() => ({ mockGetDatabase: vi.fn() }));
vi.mock("../../../src/lib/database", () => ({ getDatabase: mockGetDatabase }));

import {
  persistAgentSessionId,
  persistCompaction,
  persistMessageStarted,
  persistPart,
  persistSessionError,
  persistSessionTitle,
  persistSessionUsage,
  persistSessionWorking,
  persistTurnEnded,
} from "../../../src/services/agent/persistence";

// ============================================================================
// Fixtures
// ============================================================================

const SESSION = "sess-1";
const TURN = "turn-1";
const T = Date.parse("2026-08-14T12:00:00.000Z");

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  db.prepare(
    `INSERT INTO repositories (id, name, root_path) VALUES ('r1', 'repo', '/tmp/repo')`
  ).run();
  db.prepare(`INSERT INTO workspaces (id, repository_id, slug) VALUES ('w1', 'r1', 'ws')`).run();
  db.prepare(
    `INSERT INTO sessions (id, workspace_id, agent_harness) VALUES (?, 'w1', 'claude-code')`
  ).run(SESSION);
  return db;
}

function started(over: Partial<MessageStartedEvent> = {}): MessageStartedEvent {
  return {
    type: "message.started",
    sessionId: SESSION,
    turnId: TURN,
    messageId: "msg-1",
    outputIndex: 1,
    role: "assistant",
    timestamp: T,
    ...over,
  };
}

function part(over: Partial<MessagePartEvent> = {}): MessagePartEvent {
  return {
    type: "message.part",
    sessionId: SESSION,
    turnId: TURN,
    messageId: "msg-1",
    outputIndex: 1,
    partIndex: 0,
    part: {
      type: "text",
      id: "p1",
      sessionId: SESSION,
      messageId: "msg-1",
      text: "hello",
      state: "done",
    },
    timestamp: T,
    ...over,
  };
}

function ended(over: Partial<TurnEndedEvent> = {}): TurnEndedEvent {
  return {
    type: "turn.ended",
    sessionId: SESSION,
    turnId: TURN,
    stopReason: "end_turn",
    timestamp: T,
    ...over,
  };
}

// ============================================================================

describeWithDb("agent persistence (canonical events → SQLite)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    mockGetDatabase.mockReturnValue(db);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // messages
  // --------------------------------------------------------------------------

  describe("persistMessageStarted", () => {
    it("writes the turn id, model, parent tool call and the event's timestamp", () => {
      const result = persistMessageStarted(
        started({ model: "claude-opus-5", parentToolCallId: "tool-7" })
      );

      expect(result).toEqual({ ok: true, value: "msg-1" });
      const row = db.prepare(`SELECT * FROM messages WHERE id = 'msg-1'`).get() as Record<
        string,
        unknown
      >;
      expect(row).toMatchObject({
        session_id: SESSION,
        role: "assistant",
        turn_id: TURN,
        model: "claude-opus-5",
        parent_tool_call_id: "tool-7",
        sent_at: "2026-08-14T12:00:00.000Z",
      });
      // New rows render from parts; `content` is a legacy read path only.
      expect(row.content).toBeNull();
    });

    it("persists the engine's user echo — the send command writes no row", () => {
      persistMessageStarted(started({ role: "user", outputIndex: 0, messageId: "user-1" }));

      const row = db.prepare(`SELECT role, turn_id FROM messages WHERE id = 'user-1'`).get();
      expect(row).toEqual({ role: "user", turn_id: TURN });
    });

    it("is idempotent on replay (same id rewrites the same row)", () => {
      persistMessageStarted(started());
      persistMessageStarted(started());

      const count = db
        .prepare(`SELECT count(*) as n FROM messages WHERE session_id = ?`)
        .get(SESSION) as { n: number };
      expect(count.n).toBe(1);
    });

    it("refuses a message for an unknown session instead of throwing", () => {
      const result = persistMessageStarted(started({ sessionId: "nope" }));
      expect(result).toEqual({ ok: false, error: "session not found" });
    });

    it("lets the trigger assign seq and bump the denormalized message_count", () => {
      persistMessageStarted(started({ messageId: "m1", role: "user", outputIndex: 0 }));
      persistMessageStarted(started({ messageId: "m2" }));

      const rows = db
        .prepare(`SELECT id, seq FROM messages WHERE session_id = ? ORDER BY seq`)
        .all(SESSION) as Array<{ id: string; seq: number }>;
      expect(rows.map((r) => r.id)).toEqual(["m1", "m2"]);
      expect(rows[0].seq).toBeLessThan(rows[1].seq);

      const session = db.prepare(`SELECT message_count FROM sessions WHERE id = ?`).get(SESSION);
      expect(session).toEqual({ message_count: 2 });
    });
  });

  // --------------------------------------------------------------------------
  // parts
  // --------------------------------------------------------------------------

  describe("persistPart", () => {
    beforeEach(() => persistMessageStarted(started()));

    it("stores the engine Part verbatim with lowercase type and partIndex as seq", () => {
      persistPart(part({ partIndex: 3 }));

      const row = db.prepare(`SELECT * FROM parts WHERE id = 'p1'`).get() as Record<
        string,
        unknown
      >;
      expect(row).toMatchObject({ message_id: "msg-1", session_id: SESSION, seq: 3, type: "text" });
      expect(JSON.parse(row.data as string)).toEqual({
        type: "text",
        id: "p1",
        sessionId: SESSION,
        messageId: "msg-1",
        text: "hello",
        state: "done",
      });
    });

    it("promotes toolCallId/toolName to columns for tool parts", () => {
      persistPart(
        part({
          part: {
            type: "tool",
            id: "p2",
            sessionId: SESSION,
            messageId: "msg-1",
            toolCallId: "call-1",
            toolName: "Bash",
            kind: "execute",
            state: {
              status: "completed",
              input: { command: "ls" },
              output: "a\nb",
              time: { start: T, end: T + 10 },
            },
          },
        })
      );

      const row = db.prepare(`SELECT tool_call_id, tool_name FROM parts WHERE id = 'p2'`).get();
      expect(row).toEqual({ tool_call_id: "call-1", tool_name: "Bash" });
    });

    it("upserts by part id — a later snapshot replaces the earlier state", () => {
      persistPart(
        part({
          part: {
            type: "tool",
            id: "p3",
            sessionId: SESSION,
            messageId: "msg-1",
            toolCallId: "call-2",
            toolName: "Read",
            state: { status: "pending", partialInput: '{"pa' },
          },
        })
      );
      persistPart(
        part({
          part: {
            type: "tool",
            id: "p3",
            sessionId: SESSION,
            messageId: "msg-1",
            toolCallId: "call-2",
            toolName: "Read",
            state: {
              status: "completed",
              input: { path: "/x" },
              output: "file body",
              time: { start: T, end: T + 5 },
            },
          },
        })
      );

      const rows = db.prepare(`SELECT data FROM parts WHERE id = 'p3'`).all() as Array<{
        data: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0].data).state.status).toBe("completed");
    });

    it("keeps subagent parts linked to the tool call that spawned them", () => {
      persistPart(
        part({
          part: {
            type: "text",
            id: "p4",
            sessionId: SESSION,
            messageId: "msg-1",
            text: "from the subagent",
            parentToolCallId: "task-1",
          },
        })
      );

      const row = db.prepare(`SELECT parent_tool_call_id FROM parts WHERE id = 'p4'`).get();
      expect(row).toEqual({ parent_tool_call_id: "task-1" });
    });

    it("swallows a part whose message row never landed (FK) — the next snapshot retries", () => {
      const result = persistPart(part({ messageId: "ghost", part: { ...part().part, id: "p5" } }));

      expect(result.ok).toBe(true);
      expect(db.prepare(`SELECT count(*) as n FROM parts WHERE id = 'p5'`).get()).toEqual({ n: 0 });
    });
  });

  // --------------------------------------------------------------------------
  // turn.ended
  // --------------------------------------------------------------------------

  describe("persistTurnEnded", () => {
    beforeEach(() => {
      persistMessageStarted(started({ messageId: "u1", role: "user", outputIndex: 0 }));
      persistMessageStarted(started({ messageId: "a1" }));
      persistMessageStarted(started({ messageId: "a2" }));
      // A subagent message must never be mistaken for the turn's last output.
      persistMessageStarted(started({ messageId: "sub", parentToolCallId: "task-1" }));
    });

    it("writes tokens, cost and the stop reason onto the turn's last top-level assistant message", () => {
      persistTurnEnded(
        ended({
          tokens: { input: 100, output: 20, cache: { read: 5, write: 1 } },
          cost: 0.25,
          stopReason: "refusal",
        }),
        { status: "idle", cancelled: false }
      );

      const row = db
        .prepare(`SELECT tokens, cost, turn_stop_reason FROM messages WHERE id='a2'`)
        .get() as {
        tokens: string;
        cost: number;
        turn_stop_reason: string;
      };
      expect(JSON.parse(row.tokens)).toEqual({
        input: 100,
        output: 20,
        cache: { read: 5, write: 1 },
      });
      expect(row.cost).toBe(0.25);
      expect(row.turn_stop_reason).toBe("refusal");

      // Nothing lands on the subagent message or the earlier assistant message.
      const others = db.prepare(`SELECT id FROM messages WHERE tokens IS NOT NULL`).all() as Array<{
        id: string;
      }>;
      expect(others.map((r) => r.id)).toEqual(["a2"]);
    });

    it("stamps cancelled_at instead of inserting a synthetic cancelled message", () => {
      persistTurnEnded(ended({ stopReason: "cancelled" }), { status: "idle", cancelled: true });

      const row = db.prepare(`SELECT cancelled_at FROM messages WHERE id = 'a2'`).get() as {
        cancelled_at: string;
      };
      expect(row.cancelled_at).toBe("2026-08-14T12:00:00.000Z");
      // No extra row, and no raw JSON envelope in `content`.
      const count = db
        .prepare(`SELECT count(*) as n FROM messages WHERE session_id = ?`)
        .get(SESSION);
      expect(count).toEqual({ n: 4 });
      expect(db.prepare(`SELECT status FROM sessions WHERE id = ?`).get(SESSION)).toEqual({
        status: "idle",
      });
    });

    it("writes the error status with the engine's category", () => {
      persistTurnEnded(ended({ stopReason: "error" }), {
        status: "error",
        cancelled: false,
        error: { message: "429 slow down", category: "rate_limit" },
      });

      expect(
        db
          .prepare(`SELECT status, error_message, error_category FROM sessions WHERE id = ?`)
          .get(SESSION)
      ).toEqual({ status: "error", error_message: "429 slow down", error_category: "rate_limit" });
    });

    it("clears a stale error when the next turn ends cleanly", () => {
      persistSessionError(SESSION, "boom", "internal");
      persistTurnEnded(ended(), { status: "idle", cancelled: false });

      expect(
        db.prepare(`SELECT status, error_message FROM sessions WHERE id = ?`).get(SESSION)
      ).toEqual({ status: "idle", error_message: null });
    });

    it("still flips the session when the turn produced no assistant message", () => {
      db.prepare(`DELETE FROM messages WHERE role = 'assistant'`).run();

      const result = persistTurnEnded(ended(), { status: "idle", cancelled: false });

      expect(result.ok).toBe(true);
      expect(db.prepare(`SELECT status FROM sessions WHERE id = ?`).get(SESSION)).toEqual({
        status: "idle",
      });
    });
  });

  // --------------------------------------------------------------------------
  // session state
  // --------------------------------------------------------------------------

  describe("persistSessionUsage", () => {
    it("keeps the last known percent when the harness reports no window size", () => {
      const usage = (over: Partial<SessionUsageEvent>): SessionUsageEvent => ({
        type: "session.usage",
        sessionId: SESSION,
        turnId: TURN,
        used: 0,
        timestamp: T,
        ...over,
      });

      persistSessionUsage(usage({ used: 100_000, size: 200_000 }));
      expect(
        db.prepare(`SELECT context_used_percent FROM sessions WHERE id = ?`).get(SESSION)
      ).toEqual({ context_used_percent: 50 });

      // Claude reports `size` only on the final result — a size-less update
      // must not zero the gauge mid-turn.
      persistSessionUsage(usage({ used: 120_000 }));
      expect(
        db
          .prepare(`SELECT context_token_count, context_used_percent FROM sessions WHERE id = ?`)
          .get(SESSION)
      ).toEqual({ context_token_count: 120_000, context_used_percent: 50 });
    });

    it("clamps the percent at 100", () => {
      persistSessionUsage({
        type: "session.usage",
        sessionId: SESSION,
        turnId: TURN,
        used: 300_000,
        size: 200_000,
        timestamp: T,
      });
      expect(
        db.prepare(`SELECT context_used_percent FROM sessions WHERE id = ?`).get(SESSION)
      ).toEqual({ context_used_percent: 100 });
    });
  });

  describe("persistSessionWorking", () => {
    it("flips to working and stamps last_user_message_at for sidebar ordering", () => {
      persistSessionError(SESSION, "old failure", "network");

      persistSessionWorking(SESSION, "2026-08-14T12:00:00.000Z");

      expect(
        db
          .prepare(
            `SELECT status, last_user_message_at, error_message, error_category FROM sessions WHERE id = ?`
          )
          .get(SESSION)
      ).toEqual({
        status: "working",
        last_user_message_at: "2026-08-14T12:00:00.000Z",
        error_message: null,
        error_category: null,
      });
    });
  });

  describe("persistAgentSessionId", () => {
    it("stores the harness-native id for the next resume", () => {
      persistAgentSessionId(SESSION, "native-abc");
      expect(db.prepare(`SELECT agent_session_id FROM sessions WHERE id = ?`).get(SESSION)).toEqual(
        {
          agent_session_id: "native-abc",
        }
      );
    });
  });

  describe("persistSessionTitle", () => {
    it("sets the session title and adopts it for an untitled workspace", () => {
      persistSessionTitle(SESSION, "Fix login");

      expect(db.prepare(`SELECT title FROM sessions WHERE id = ?`).get(SESSION)).toEqual({
        title: "Fix login",
      });
      expect(db.prepare(`SELECT title FROM workspaces WHERE id = 'w1'`).get()).toEqual({
        title: "Fix login",
      });
    });

    it("never overwrites a workspace title the user or a PR already set", () => {
      db.prepare(`UPDATE workspaces SET title = 'Mine' WHERE id = 'w1'`).run();

      persistSessionTitle(SESSION, "Auto title");

      expect(db.prepare(`SELECT title FROM workspaces WHERE id = 'w1'`).get()).toEqual({
        title: "Mine",
      });
    });
  });

  // --------------------------------------------------------------------------
  // compactions
  // --------------------------------------------------------------------------

  describe("persistCompaction", () => {
    const compaction = (over: Partial<SessionCompactionEvent> = {}): SessionCompactionEvent => ({
      type: "session.compaction",
      sessionId: SESSION,
      turnId: TURN,
      compactionId: "cmp-1",
      status: "in_progress",
      timestamp: T,
      ...over,
    });

    it("inserts the marker row", () => {
      persistCompaction(compaction({ trigger: "auto", preTokens: 180_000 }));

      expect(db.prepare(`SELECT * FROM compactions WHERE compaction_id = 'cmp-1'`).get()).toEqual({
        compaction_id: "cmp-1",
        session_id: SESSION,
        turn_id: TURN,
        status: "in_progress",
        trigger: "auto",
        pre_tokens: 180_000,
        post_tokens: null,
        summary: null,
        created_at: "2026-08-14T12:00:00.000Z",
      });
    });

    it("advances status in place, keeping its anchored position and earlier fields", () => {
      persistCompaction(compaction({ trigger: "auto", preTokens: 180_000 }));
      persistCompaction(
        compaction({
          status: "completed",
          postTokens: 20_000,
          summary: "…",
          timestamp: T + 60_000,
        })
      );

      const rows = db.prepare(`SELECT * FROM compactions`).all() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: "completed",
        trigger: "auto",
        pre_tokens: 180_000,
        post_tokens: 20_000,
        summary: "…",
        // First appearance anchors the entity — it never moves.
        created_at: "2026-08-14T12:00:00.000Z",
      });
    });
  });

  // --------------------------------------------------------------------------
  // failure surface
  // --------------------------------------------------------------------------

  describe("write failures", () => {
    it("returns ok:false instead of throwing when the database is gone", () => {
      db.close();

      expect(persistSessionError(SESSION, "x", "internal").ok).toBe(false);
      expect(persistTurnEnded(ended(), { status: "idle", cancelled: false }).ok).toBe(false);
      expect(
        persistCompaction({
          type: "session.compaction",
          sessionId: SESSION,
          turnId: TURN,
          compactionId: "c",
          status: "completed",
          timestamp: T,
        }).ok
      ).toBe(false);

      // Re-open so afterEach's close() is a no-op on an already-closed handle.
      db = createTestDb();
    });
  });
});
