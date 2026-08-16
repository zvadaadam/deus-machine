/**
 * Integration tests for the full pipeline: engine lifecycle envelopes → event
 * handler → persistence → real SQLite.
 *
 * agent-persistence.test.ts pins each write in isolation; this file feeds
 * whole turns — the exact event scripts the harness adapters emit — and checks
 * the rows a reload would read back. Only the WS push, query invalidation and
 * the PR snapshot refresh are mocked; the database is real.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LifecycleEvent, WireEventEnvelope } from "@zvada/agent-server/protocol";

// better-sqlite3 may be compiled for Electron's Node ABI — skip if unavailable
let canUseDatabase = true;
try {
  new Database(":memory:").close();
} catch {
  canUseDatabase = false;
}
const describeWithDb = canUseDatabase ? describe : describe.skip;

import { SCHEMA_SQL } from "@shared/schema";

const { mockGetDatabase, mockInvalidate, mockBroadcast, mockRefreshPr } = vi.hoisted(() => ({
  mockGetDatabase: vi.fn(),
  mockInvalidate: vi.fn(),
  mockBroadcast: vi.fn(),
  mockRefreshPr: vi.fn(),
}));

vi.mock("../../../src/lib/database", () => ({ getDatabase: mockGetDatabase }));
vi.mock("../../../src/services/query-engine", () => ({ invalidate: mockInvalidate }));
vi.mock("../../../src/services/ws.service", () => ({ broadcast: mockBroadcast }));
vi.mock("../../../src/services/pr-snapshot.service", () => ({
  refreshPrSnapshotForSession: mockRefreshPr,
}));

import { createAgentEventHandler } from "../../../src/services/agent/event-handler";
import { getCompactions } from "../../../src/db/queries";

// ============================================================================
// Helpers
// ============================================================================

const SESSION = "sess-integration";
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
    `INSERT INTO sessions (id, workspace_id, agent_harness, status) VALUES (?, 'w1', 'claude-code', 'working')`
  ).run(SESSION);
  return db;
}

interface MessageRowShape {
  id: string;
  role: string;
  turn_id: string | null;
  seq: number;
  cancelled_at: string | null;
  parent_tool_call_id: string | null;
  tokens: string | null;
  cost: number | null;
  turn_stop_reason: string | null;
}

interface PartRowShape {
  id: string;
  message_id: string;
  seq: number;
  type: string;
  data: string;
  tool_call_id: string | null;
  tool_name: string | null;
  parent_tool_call_id: string | null;
}

/** One complete text turn, echo included — the script an adapter emits. */
function plainTurn(): LifecycleEvent[] {
  return [
    { type: "turn.started", sessionId: SESSION, turnId: TURN, timestamp: T },
    {
      type: "session.created",
      sessionId: SESSION,
      nativeSessionId: "native-1",
      harness: "claude-code",
      timestamp: T,
    },
    // The user echo — this is what makes the user's message durable.
    {
      type: "message.started",
      sessionId: SESSION,
      turnId: TURN,
      messageId: "u1",
      outputIndex: 0,
      role: "user",
      timestamp: T,
    },
    {
      type: "message.part",
      sessionId: SESSION,
      turnId: TURN,
      messageId: "u1",
      outputIndex: 0,
      partIndex: 0,
      part: { type: "text", id: "up1", sessionId: SESSION, messageId: "u1", text: "what is 2+2?" },
      timestamp: T,
    },
    { type: "message.ended", sessionId: SESSION, turnId: TURN, messageId: "u1", timestamp: T },
    {
      type: "message.started",
      sessionId: SESSION,
      turnId: TURN,
      messageId: "a1",
      outputIndex: 1,
      role: "assistant",
      model: "claude-opus-5",
      timestamp: T + 1,
    },
    {
      type: "message.part",
      sessionId: SESSION,
      turnId: TURN,
      messageId: "a1",
      outputIndex: 1,
      partIndex: 0,
      part: {
        type: "text",
        id: "ap1",
        sessionId: SESSION,
        messageId: "a1",
        text: "Four",
        state: "done",
      },
      timestamp: T + 2,
    },
    { type: "message.ended", sessionId: SESSION, turnId: TURN, messageId: "a1", timestamp: T + 3 },
    {
      type: "turn.ended",
      sessionId: SESSION,
      turnId: TURN,
      stopReason: "end_turn",
      tokens: { input: 12, output: 3 },
      cost: 0.0004,
      timestamp: T + 4,
    },
  ];
}

describeWithDb("engine turn → handler → SQLite", () => {
  let db: Database.Database;
  let handler: ReturnType<typeof createAgentEventHandler>;
  let seq = 0;

  const feed = (...events: LifecycleEvent[]): void => {
    for (const event of events) {
      const envelope: WireEventEnvelope = { sessionId: SESSION, seq: ++seq, event };
      handler.handle(envelope);
    }
  };

  const messages = (): MessageRowShape[] =>
    db
      .prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY seq`)
      .all(SESSION) as MessageRowShape[];

  const parts = (): PartRowShape[] =>
    db
      .prepare(
        `SELECT p.* FROM parts p JOIN messages m ON p.message_id = m.id
         WHERE m.session_id = ? ORDER BY m.seq, p.seq`
      )
      .all(SESSION) as PartRowShape[];

  const sessionRow = (): Record<string, unknown> =>
    db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(SESSION) as Record<string, unknown>;

  beforeEach(() => {
    seq = 0;
    db = createTestDb();
    mockGetDatabase.mockReturnValue(db);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    handler = createAgentEventHandler();
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  // ==========================================================================
  // A plain text turn, echo included
  // ==========================================================================

  it("persists the user echo and the assistant answer as one turn", () => {
    feed(...plainTurn());

    const rows = messages();
    expect(rows.map((r) => [r.id, r.role, r.turn_id])).toEqual([
      ["u1", "user", TURN],
      ["a1", "assistant", TURN],
    ]);
    // The user row renders from parts — there is no message-level content.
    expect(parts().map((p) => [p.message_id, p.type])).toEqual([
      ["u1", "text"],
      ["a1", "text"],
    ]);

    // Turn accounting lands on the last top-level assistant message.
    expect(JSON.parse(rows[1].tokens as string)).toEqual({ input: 12, output: 3 });
    expect(rows[1].cost).toBe(0.0004);
    expect(rows[1].turn_stop_reason).toBe("end_turn");

    expect(sessionRow()).toMatchObject({ status: "idle", agent_session_id: "native-1" });
  });

  // ==========================================================================
  // Replay (PROTOCOL §7.3-8)
  // ==========================================================================

  it("re-delivering the whole turn changes nothing (gap heal / events.replay)", () => {
    feed(...plainTurn());

    const before = { messages: messages(), parts: parts(), session: sessionRow() };

    // A reconnected client whose in-memory lastSeq restarted at 0 asks the wire
    // for the buffered history; every envelope arrives a second time.
    feed(...plainTurn());

    expect(messages()).toEqual(before.messages);
    expect(parts()).toEqual(before.parts);
    expect(sessionRow()).toEqual(before.session);
  });

  // ==========================================================================
  // Tool call across two assistant messages
  // ==========================================================================

  it("keeps a tool part addressable across messages and completes it late", () => {
    const toolPart = (status: "pending" | "in_progress" | "completed") => ({
      type: "tool" as const,
      id: "tp1",
      sessionId: SESSION,
      messageId: "a1",
      toolCallId: "call-1",
      toolName: "Bash",
      kind: "execute",
      state:
        status === "pending"
          ? { status: "pending" as const, partialInput: '{"comm' }
          : status === "in_progress"
            ? { status: "in_progress" as const, input: { command: "ls" }, time: { start: T } }
            : {
                status: "completed" as const,
                input: { command: "ls" },
                output: "a\nb",
                content: [{ type: "text" as const, text: "a\nb" }],
                time: { start: T, end: T + 50 },
              },
    });

    feed(
      {
        type: "message.started",
        sessionId: SESSION,
        turnId: TURN,
        messageId: "a1",
        outputIndex: 1,
        role: "assistant",
        timestamp: T,
      },
      {
        type: "message.part",
        sessionId: SESSION,
        turnId: TURN,
        messageId: "a1",
        outputIndex: 1,
        partIndex: 0,
        part: toolPart("pending"),
        timestamp: T,
      },
      {
        type: "message.part",
        sessionId: SESSION,
        turnId: TURN,
        messageId: "a1",
        outputIndex: 1,
        partIndex: 0,
        part: toolPart("in_progress"),
        timestamp: T + 1,
      },
      {
        type: "message.ended",
        sessionId: SESSION,
        turnId: TURN,
        messageId: "a1",
        timestamp: T + 2,
      },
      {
        type: "message.started",
        sessionId: SESSION,
        turnId: TURN,
        messageId: "a2",
        outputIndex: 2,
        role: "assistant",
        timestamp: T + 3,
      },
      // The tool completes AFTER its message ended — the snapshot names the
      // original messageId and the upsert must land back there.
      {
        type: "message.part",
        sessionId: SESSION,
        turnId: TURN,
        messageId: "a1",
        outputIndex: 1,
        partIndex: 0,
        part: toolPart("completed"),
        timestamp: T + 4,
      }
    );

    const rows = parts();
    expect(rows).toHaveLength(1);
    expect(rows[0].message_id).toBe("a1");
    expect(rows[0].tool_name).toBe("Bash");
    const stored = JSON.parse(rows[0].data);
    expect(stored.state.status).toBe("completed");
    // The display-grade content survives the round trip intact.
    expect(stored.state.content).toEqual([{ type: "text", text: "a\nb" }]);
  });

  // ==========================================================================
  // Subagent nesting
  // ==========================================================================

  it("nests a subagent's message under the tool call that spawned it", () => {
    feed(
      {
        type: "message.started",
        sessionId: SESSION,
        turnId: TURN,
        messageId: "a1",
        outputIndex: 1,
        role: "assistant",
        timestamp: T,
      },
      {
        type: "message.part",
        sessionId: SESSION,
        turnId: TURN,
        messageId: "a1",
        outputIndex: 1,
        partIndex: 0,
        part: {
          type: "tool",
          id: "tp1",
          sessionId: SESSION,
          messageId: "a1",
          toolCallId: "task-1",
          toolName: "Task",
          kind: "task",
          subagent: { type: "explorer", description: "Find the bug", model: "sonnet" },
          state: { status: "in_progress", input: {}, time: { start: T } },
        },
        timestamp: T,
      },
      {
        type: "message.started",
        sessionId: SESSION,
        turnId: TURN,
        messageId: "sub-1",
        outputIndex: 2,
        role: "assistant",
        parentToolCallId: "task-1",
        timestamp: T + 1,
      },
      {
        type: "message.part",
        sessionId: SESSION,
        turnId: TURN,
        messageId: "sub-1",
        outputIndex: 2,
        partIndex: 0,
        part: {
          type: "text",
          id: "sp1",
          sessionId: SESSION,
          messageId: "sub-1",
          text: "found it",
          parentToolCallId: "task-1",
        },
        timestamp: T + 1,
      }
    );

    const rows = messages();
    expect(rows.find((r) => r.id === "sub-1")?.parent_tool_call_id).toBe("task-1");
    expect(parts().find((p) => p.id === "sp1")?.parent_tool_call_id).toBe("task-1");
    // The subagent metadata rides on the spawning tool part, not a name list.
    const tool = JSON.parse(parts().find((p) => p.id === "tp1")!.data);
    expect(tool.subagent).toEqual({
      type: "explorer",
      description: "Find the bug",
      model: "sonnet",
    });
  });

  // ==========================================================================
  // Cancellation
  // ==========================================================================

  it("marks the turn's last assistant message cancelled and goes idle", () => {
    feed(
      {
        type: "message.started",
        sessionId: SESSION,
        turnId: TURN,
        messageId: "u1",
        outputIndex: 0,
        role: "user",
        timestamp: T,
      },
      {
        type: "message.started",
        sessionId: SESSION,
        turnId: TURN,
        messageId: "a1",
        outputIndex: 1,
        role: "assistant",
        timestamp: T + 1,
      },
      {
        type: "turn.ended",
        sessionId: SESSION,
        turnId: TURN,
        stopReason: "cancelled",
        timestamp: T + 2,
      }
    );

    const rows = messages();
    expect(rows).toHaveLength(2);
    expect(rows[1].cancelled_at).toBe(new Date(T + 2).toISOString());
    expect(rows[1].turn_stop_reason).toBe("cancelled");
    expect(sessionRow().status).toBe("idle");
  });

  // ==========================================================================
  // Errors
  // ==========================================================================

  it("swallows a recoverable error and lets the turn finish normally", () => {
    feed(
      {
        type: "message.started",
        sessionId: SESSION,
        turnId: TURN,
        messageId: "a1",
        outputIndex: 1,
        role: "assistant",
        timestamp: T,
      },
      {
        type: "error",
        sessionId: SESSION,
        turnId: TURN,
        category: "rate_limit",
        message: "429, retrying",
        recoverable: true,
        timestamp: T + 1,
      }
    );

    // Mid-turn: the session must still look like it is working.
    expect(sessionRow()).toMatchObject({ status: "working", error_message: null });

    feed({
      type: "turn.ended",
      sessionId: SESSION,
      turnId: TURN,
      stopReason: "end_turn",
      timestamp: T + 2,
    });

    expect(sessionRow()).toMatchObject({ status: "idle", error_message: null });
  });

  it("records a terminal error once, with the engine's category", () => {
    feed(
      {
        type: "error",
        sessionId: SESSION,
        turnId: TURN,
        category: "auth",
        message: "not logged in",
        recoverable: false,
        timestamp: T,
      },
      {
        type: "turn.ended",
        sessionId: SESSION,
        turnId: TURN,
        stopReason: "error",
        error: { category: "internal", message: "agent turn failed" },
        timestamp: T + 1,
      }
    );

    // The specific message survives the vaguer terminal one.
    expect(sessionRow()).toMatchObject({
      status: "error",
      error_message: "not logged in",
      error_category: "auth",
    });
  });

  // ==========================================================================
  // Compaction
  // ==========================================================================

  it("stores the compaction marker and reads it back through the messages query", () => {
    feed(
      {
        type: "session.compaction",
        sessionId: SESSION,
        turnId: TURN,
        compactionId: "cmp-1",
        status: "in_progress",
        trigger: "auto",
        preTokens: 180_000,
        timestamp: T,
      },
      {
        type: "session.compaction",
        sessionId: SESSION,
        turnId: TURN,
        compactionId: "cmp-1",
        status: "completed",
        postTokens: 20_000,
        summary: "Earlier work summarized.",
        timestamp: T + 5_000,
      }
    );

    const rows = getCompactions(db, SESSION);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      compaction_id: "cmp-1",
      turn_id: TURN,
      status: "completed",
      trigger: "auto",
      pre_tokens: 180_000,
      post_tokens: 20_000,
      summary: "Earlier work summarized.",
    });
  });

  // ==========================================================================
  // Context gauge
  // ==========================================================================

  it("merges the context gauge stickily across a turn", () => {
    feed(
      {
        type: "session.usage",
        sessionId: SESSION,
        turnId: TURN,
        used: 50_000,
        size: 200_000,
        timestamp: T,
      },
      { type: "session.usage", sessionId: SESSION, turnId: TURN, used: 60_000, timestamp: T + 1 }
    );

    // Claude reports `size` only on the final result, so the second event has
    // none. The fold remembers it, which is why the percent now RECOMPUTES
    // (60k/200k) instead of freezing at the first event's 25 while the token
    // count moved on — the two used to disagree on screen for a whole turn.
    expect(sessionRow()).toMatchObject({
      context_token_count: 60_000,
      context_used_percent: 30,
    });
  });

  // ==========================================================================
  // FK integrity
  // ==========================================================================

  it("never writes a part whose message row does not exist", () => {
    feed({
      type: "message.part",
      sessionId: SESSION,
      turnId: TURN,
      messageId: "ghost",
      outputIndex: 1,
      partIndex: 0,
      part: { type: "text", id: "p", sessionId: SESSION, messageId: "ghost", text: "x" },
      timestamp: T,
    });

    const orphans = db
      .prepare(
        `SELECT count(*) as n FROM parts p LEFT JOIN messages m ON p.message_id = m.id
                WHERE m.id IS NULL`
      )
      .get() as { n: number };
    expect(orphans.n).toBe(0);
  });

  // ==========================================================================
  // Deltas are forward-only (spec 04 §C2): no row write per token
  // ==========================================================================

  it("writes nothing for a text delta — the DB stays at snapshot granularity", () => {
    feed(
      { type: "turn.started", sessionId: SESSION, turnId: TURN, timestamp: T },
      {
        type: "message.started",
        sessionId: SESSION,
        turnId: TURN,
        messageId: "a1",
        outputIndex: 1,
        role: "assistant",
        timestamp: T,
      },
      {
        type: "message.part",
        sessionId: SESSION,
        turnId: TURN,
        messageId: "a1",
        outputIndex: 1,
        partIndex: 0,
        part: { type: "text", id: "p1", sessionId: SESSION, messageId: "a1", text: "" },
        timestamp: T,
      }
    );
    const before = db.prepare(`SELECT data FROM parts WHERE id = 'p1'`).get() as { data: string };

    for (let i = 0; i < 50; i++) {
      feed({
        type: "message.part.delta",
        sessionId: SESSION,
        turnId: TURN,
        messageId: "a1",
        partId: "p1",
        outputIndex: 1,
        partIndex: 0,
        delta: { type: "text", text: `token-${i} ` },
        timestamp: T + i,
      });
    }

    // The row still holds the last SNAPSHOT — 50 deltas caused 0 part writes.
    // (Their text is not lost: the fold carries it, the frontend renders it,
    // and the settling `message.part` snapshot persists it.)
    const after = db.prepare(`SELECT data FROM parts WHERE id = 'p1'`).get() as { data: string };
    expect(after.data).toBe(before.data);

    feed({
      type: "message.part",
      sessionId: SESSION,
      turnId: TURN,
      messageId: "a1",
      outputIndex: 1,
      partIndex: 0,
      part: { type: "text", id: "p1", sessionId: SESSION, messageId: "a1", text: "the answer" },
      timestamp: T + 99,
    });
    const settled = db.prepare(`SELECT data FROM parts WHERE id = 'p1'`).get() as { data: string };
    expect(JSON.parse(settled.data)).toMatchObject({ text: "the answer" });
  });
});
