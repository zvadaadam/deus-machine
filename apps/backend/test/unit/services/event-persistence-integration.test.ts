/**
 * Integration tests for event → persistence → DB pipeline.
 *
 * Unlike agent-persistence.test.ts (which mocks the DB), these tests create
 * a real in-memory SQLite database, apply the full schema + migrations, and
 * verify the actual row state after feeding events through persistence functions.
 *
 * The goal: confirm that canonical events from the agent-server adapters
 * produce the correct messages and parts rows in the database.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// better-sqlite3 may be compiled for Electron's Node ABI — skip if unavailable
let canUseDatabase = true;
try {
  new Database(":memory:").close();
} catch {
  canUseDatabase = false;
}

const describeWithDb = canUseDatabase ? describe : describe.skip;
import { SCHEMA_SQL, MIGRATIONS } from "@shared/schema";
import { uuidv7 } from "@shared/lib/uuid";

// ============================================================================
// Mock getDatabase() to return our in-memory DB
// ============================================================================

const { mockGetDatabase } = vi.hoisted(() => ({
  mockGetDatabase: vi.fn(),
}));

vi.mock("../../../src/lib/database", () => ({
  getDatabase: mockGetDatabase,
}));

// ============================================================================
// Import persistence functions AFTER mocks are set up
// ============================================================================

import {
  persistMessageCreated,
  persistPartDone,
  persistMessageDone,
} from "../../../src/services/agent/persistence";
import type {
  MessageCreatedEvent,
  PartDoneEvent,
  MessageDoneEvent,
} from "../../../../shared/agent-events";

// ============================================================================
// Helpers
// ============================================================================

/** Create an in-memory SQLite DB with full schema + migrations applied. */
function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Apply full schema (tables, indexes, triggers)
  db.exec(SCHEMA_SQL);

  // Apply post-launch migrations (ALTER TABLEs, new tables)
  for (const sql of MIGRATIONS) {
    try {
      db.exec(sql);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "";
      if (!msg.includes("duplicate column") && !msg.includes("already exists")) throw e;
    }
  }

  return db;
}

/** Seed the minimum FK chain: repository → workspace → session. */
function seedSession(
  db: Database.Database,
  sessionId: string
): {
  repositoryId: string;
  workspaceId: string;
} {
  const repositoryId = uuidv7();
  const workspaceId = uuidv7();

  db.prepare(`INSERT INTO repositories (id, name, root_path) VALUES (?, ?, ?)`).run(
    repositoryId,
    "test-repo",
    `/tmp/test-repo-${repositoryId}`
  );

  db.prepare(`INSERT INTO workspaces (id, repository_id, slug) VALUES (?, ?, ?)`).run(
    workspaceId,
    repositoryId,
    "test-ws"
  );

  db.prepare(`INSERT INTO sessions (id, workspace_id, agent_type, model) VALUES (?, ?, ?, ?)`).run(
    sessionId,
    workspaceId,
    "claude",
    "opus"
  );

  return { repositoryId, workspaceId };
}

// Typed row interfaces for querying
interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  stop_reason: string | null;
  agent_message_id: string | null;
  seq: number;
}

interface PartRow {
  id: string;
  message_id: string;
  session_id: string;
  type: string;
  data: string;
  tool_call_id: string | null;
  tool_name: string | null;
  parent_tool_call_id: string | null;
}

// ============================================================================
// Tests
// ============================================================================

describeWithDb("event → persistence → DB integration", () => {
  let db: Database.Database;
  const sessionId = "sess-integration-1";

  beforeEach(() => {
    db = createTestDb();
    seedSession(db, sessionId);
    mockGetDatabase.mockReturnValue(db);
  });

  afterEach(() => {
    db.close();
    vi.clearAllMocks();
  });

  // ==========================================================================
  // Test 1: Simple text response
  // ==========================================================================

  describe("simple text response", () => {
    it("creates 1 assistant message and 1 TEXT part", () => {
      // 1. message.created
      const created: MessageCreatedEvent = {
        type: "message.created",
        sessionId,
        agentType: "claude",
        messageId: "msg-1",
        role: "assistant",
      };
      const createResult = persistMessageCreated(created);
      expect(createResult.ok).toBe(true);

      // 2. part.done (TEXT)
      const partDone: PartDoneEvent = {
        type: "part.done",
        sessionId,
        agentType: "claude",
        messageId: "msg-1",
        partId: "p1",
        part: {
          type: "TEXT",
          id: "p1",
          sessionId,
          messageId: "msg-1",
          text: "Four",
          state: "DONE",
        },
      };
      const partResult = persistPartDone(partDone);
      expect(partResult.ok).toBe(true);

      // 3. message.done
      const done: MessageDoneEvent = {
        type: "message.done",
        sessionId,
        agentType: "claude",
        messageId: "msg-1",
        stopReason: "end_turn",
        parts: [],
      };
      const doneResult = persistMessageDone(done);
      expect(doneResult.ok).toBe(true);

      // ── Verify messages table ──
      const messages = db
        .prepare(
          `SELECT id, session_id, role, stop_reason, agent_message_id, seq FROM messages WHERE session_id = ?`
        )
        .all(sessionId) as MessageRow[];

      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe("msg-1");
      expect(messages[0].role).toBe("assistant");
      expect(messages[0].seq).toBeGreaterThan(0); // trigger-assigned

      // ── Verify parts table ──
      const parts = db
        .prepare(
          `SELECT id, message_id, session_id, type, data, tool_call_id, tool_name FROM parts WHERE session_id = ?`
        )
        .all(sessionId) as PartRow[];

      expect(parts).toHaveLength(1);
      expect(parts[0].id).toBe("p1");
      expect(parts[0].message_id).toBe("msg-1");
      expect(parts[0].type).toBe("TEXT");
      expect(parts[0].tool_call_id).toBeNull();
      expect(parts[0].tool_name).toBeNull();

      // Verify the JSON data is parseable and contains the text
      const partData = JSON.parse(parts[0].data);
      expect(partData.type).toBe("TEXT");
      expect(partData.text).toBe("Four");
    });
  });

  // ==========================================================================
  // Test 2: Tool call with two messages
  // ==========================================================================

  describe("tool call producing two assistant messages", () => {
    it("creates 2 messages with correct stop_reasons and 3 parts", () => {
      // ── Message 1: reasoning + tool call ──
      persistMessageCreated({
        type: "message.created",
        sessionId,
        agentType: "claude",
        messageId: "msg-1",
        role: "assistant",
      });

      // Part 1: REASONING
      persistPartDone({
        type: "part.done",
        sessionId,
        agentType: "claude",
        messageId: "msg-1",
        partId: "p1",
        part: {
          type: "REASONING",
          id: "p1",
          sessionId,
          messageId: "msg-1",
          text: "Let me read the file...",
          state: "DONE",
        },
      });

      // Part 2: TOOL
      persistPartDone({
        type: "part.done",
        sessionId,
        agentType: "claude",
        messageId: "msg-1",
        partId: "p2",
        part: {
          type: "TOOL",
          id: "p2",
          sessionId,
          messageId: "msg-1",
          toolCallId: "tc1",
          toolName: "Read",
          state: {
            status: "COMPLETED",
            input: "/src/main.ts",
            output: "file contents...",
            time: { start: "2024-01-01T00:00:00Z", end: "2024-01-01T00:00:01Z" },
          },
        },
      });

      persistMessageDone({
        type: "message.done",
        sessionId,
        agentType: "claude",
        messageId: "msg-1",
        stopReason: "tool_use",
        parts: [],
      });

      // ── Message 2: text response ──
      persistMessageCreated({
        type: "message.created",
        sessionId,
        agentType: "claude",
        messageId: "msg-2",
        role: "assistant",
      });

      persistPartDone({
        type: "part.done",
        sessionId,
        agentType: "claude",
        messageId: "msg-2",
        partId: "p3",
        part: {
          type: "TEXT",
          id: "p3",
          sessionId,
          messageId: "msg-2",
          text: "The answer",
          state: "DONE",
        },
      });

      persistMessageDone({
        type: "message.done",
        sessionId,
        agentType: "claude",
        messageId: "msg-2",
        stopReason: "end_turn",
        parts: [],
      });

      // ── Verify messages table ──
      const messages = db
        .prepare(
          `SELECT id, session_id, role, stop_reason, seq FROM messages WHERE session_id = ? ORDER BY seq`
        )
        .all(sessionId) as MessageRow[];

      expect(messages).toHaveLength(2);
      expect(messages[0].id).toBe("msg-1");
      expect(messages[0].role).toBe("assistant");
      expect(messages[1].id).toBe("msg-2");
      expect(messages[1].role).toBe("assistant");

      // Verify sequential ordering
      expect(messages[0].seq).toBeLessThan(messages[1].seq);

      // ── Verify parts table ──
      const parts = db
        .prepare(
          `SELECT id, message_id, type, tool_call_id, tool_name, data FROM parts WHERE session_id = ? ORDER BY id`
        )
        .all(sessionId) as PartRow[];

      expect(parts).toHaveLength(3);

      // Part 1: REASONING linked to msg-1
      const reasoning = parts.find((p) => p.id === "p1")!;
      expect(reasoning.message_id).toBe("msg-1");
      expect(reasoning.type).toBe("REASONING");
      expect(reasoning.tool_call_id).toBeNull();

      // Part 2: TOOL linked to msg-1
      const tool = parts.find((p) => p.id === "p2")!;
      expect(tool.message_id).toBe("msg-1");
      expect(tool.type).toBe("TOOL");
      expect(tool.tool_call_id).toBe("tc1");
      expect(tool.tool_name).toBe("Read");

      // Part 3: TEXT linked to msg-2
      const text = parts.find((p) => p.id === "p3")!;
      expect(text.message_id).toBe("msg-2");
      expect(text.type).toBe("TEXT");
    });
  });

  // ==========================================================================
  // Test 3: Multiple tool calls in one message
  // ==========================================================================

  describe("multiple tool calls in one message", () => {
    it("creates 2 messages with 5 parts total — 4 on msg-1 and 1 on msg-2", () => {
      // ── Message 1: REASONING + 3 TOOL parts ──
      persistMessageCreated({
        type: "message.created",
        sessionId,
        agentType: "claude",
        messageId: "msg-1",
        role: "assistant",
      });

      persistPartDone({
        type: "part.done",
        sessionId,
        agentType: "claude",
        messageId: "msg-1",
        partId: "p1",
        part: {
          type: "REASONING",
          id: "p1",
          sessionId,
          messageId: "msg-1",
          text: "I need to check several files...",
          state: "DONE",
        },
      });

      persistPartDone({
        type: "part.done",
        sessionId,
        agentType: "claude",
        messageId: "msg-1",
        partId: "p2",
        part: {
          type: "TOOL",
          id: "p2",
          sessionId,
          messageId: "msg-1",
          toolCallId: "tc1",
          toolName: "Read",
          state: {
            status: "COMPLETED",
            input: "/src/a.ts",
            output: "...",
            time: { start: "t0", end: "t1" },
          },
        },
      });

      persistPartDone({
        type: "part.done",
        sessionId,
        agentType: "claude",
        messageId: "msg-1",
        partId: "p3",
        part: {
          type: "TOOL",
          id: "p3",
          sessionId,
          messageId: "msg-1",
          toolCallId: "tc2",
          toolName: "Read",
          state: {
            status: "COMPLETED",
            input: "/src/b.ts",
            output: "...",
            time: { start: "t0", end: "t1" },
          },
        },
      });

      persistPartDone({
        type: "part.done",
        sessionId,
        agentType: "claude",
        messageId: "msg-1",
        partId: "p4",
        part: {
          type: "TOOL",
          id: "p4",
          sessionId,
          messageId: "msg-1",
          toolCallId: "tc3",
          toolName: "Bash",
          state: {
            status: "COMPLETED",
            input: "ls -la",
            output: "total 0",
            time: { start: "t0", end: "t1" },
          },
        },
      });

      persistMessageDone({
        type: "message.done",
        sessionId,
        agentType: "claude",
        messageId: "msg-1",
        stopReason: "tool_use",
        parts: [],
      });

      // ── Message 2: TEXT response ──
      persistMessageCreated({
        type: "message.created",
        sessionId,
        agentType: "claude",
        messageId: "msg-2",
        role: "assistant",
      });

      persistPartDone({
        type: "part.done",
        sessionId,
        agentType: "claude",
        messageId: "msg-2",
        partId: "p5",
        part: {
          type: "TEXT",
          id: "p5",
          sessionId,
          messageId: "msg-2",
          text: "Here are the results...",
          state: "DONE",
        },
      });

      persistMessageDone({
        type: "message.done",
        sessionId,
        agentType: "claude",
        messageId: "msg-2",
        stopReason: "end_turn",
        parts: [],
      });

      // ── Verify messages ──
      const messages = db
        .prepare(`SELECT id, role, seq FROM messages WHERE session_id = ? ORDER BY seq`)
        .all(sessionId) as MessageRow[];

      expect(messages).toHaveLength(2);

      // ── Verify parts ──
      const allParts = db
        .prepare(
          `SELECT id, message_id, type, tool_call_id, tool_name FROM parts WHERE session_id = ?`
        )
        .all(sessionId) as PartRow[];

      expect(allParts).toHaveLength(5);

      // msg-1 parts: 1 REASONING + 3 TOOL
      const msg1Parts = allParts.filter((p) => p.message_id === "msg-1");
      expect(msg1Parts).toHaveLength(4);
      expect(msg1Parts.filter((p) => p.type === "REASONING")).toHaveLength(1);
      expect(msg1Parts.filter((p) => p.type === "TOOL")).toHaveLength(3);

      // msg-2 parts: 1 TEXT
      const msg2Parts = allParts.filter((p) => p.message_id === "msg-2");
      expect(msg2Parts).toHaveLength(1);
      expect(msg2Parts[0].type).toBe("TEXT");

      // All TOOL parts have correct tool_name and tool_call_id
      const toolParts = allParts.filter((p) => p.type === "TOOL");
      for (const tp of toolParts) {
        expect(tp.tool_call_id).toBeTruthy();
        expect(tp.tool_name).toBeTruthy();
      }

      expect(toolParts.map((p) => p.tool_call_id).sort()).toEqual(["tc1", "tc2", "tc3"]);
      expect(toolParts.map((p) => p.tool_name).sort()).toEqual(["Bash", "Read", "Read"]);
    });
  });

  // ==========================================================================
  // Test 4: FK integrity — parts reference valid messages
  // ==========================================================================

  describe("FK integrity: parts reference valid messages", () => {
    it("every part.message_id exists in the messages table", () => {
      // Create two messages with parts
      persistMessageCreated({
        type: "message.created",
        sessionId,
        agentType: "claude",
        messageId: "msg-1",
        role: "assistant",
      });
      persistPartDone({
        type: "part.done",
        sessionId,
        agentType: "claude",
        messageId: "msg-1",
        partId: "p1",
        part: {
          type: "TEXT",
          id: "p1",
          sessionId,
          messageId: "msg-1",
          text: "hello",
          state: "DONE",
        },
      });

      persistMessageCreated({
        type: "message.created",
        sessionId,
        agentType: "claude",
        messageId: "msg-2",
        role: "assistant",
      });
      persistPartDone({
        type: "part.done",
        sessionId,
        agentType: "claude",
        messageId: "msg-2",
        partId: "p2",
        part: {
          type: "REASONING",
          id: "p2",
          sessionId,
          messageId: "msg-2",
          text: "thinking...",
          state: "DONE",
        },
      });

      // Query all parts and verify each message_id exists in messages
      const parts = db
        .prepare(`SELECT id, message_id FROM parts WHERE session_id = ?`)
        .all(sessionId) as PartRow[];

      const messageIds = new Set(
        (
          db.prepare(`SELECT id FROM messages WHERE session_id = ?`).all(sessionId) as MessageRow[]
        ).map((m) => m.id)
      );

      for (const part of parts) {
        expect(messageIds.has(part.message_id)).toBe(true);
      }
    });

    it("rejects a part referencing a non-existent message (FK constraint)", () => {
      const result = persistPartDone({
        type: "part.done",
        sessionId,
        agentType: "claude",
        messageId: "non-existent-msg",
        partId: "p-orphan",
        part: {
          type: "TEXT",
          id: "p-orphan",
          sessionId,
          messageId: "non-existent-msg",
          text: "orphan",
          state: "DONE",
        },
      });

      // FK constraint failures are silently handled (returns ok: true)
      // because part.created events can arrive before message.created persistence.
      // The part will be saved on part.done when the message exists.
      expect(result.ok).toBe(true);

      // Verify no orphan parts were inserted (FK prevented actual write)
      const orphans = db.prepare(`SELECT id FROM parts WHERE id = ?`).all("p-orphan");
      expect(orphans).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Test 5: Codex single-message turn
  // ==========================================================================

  describe("Codex single-message turn with mixed parts", () => {
    it("creates 1 message with 4 parts (REASONING, TEXT, TOOL, TEXT)", () => {
      persistMessageCreated({
        type: "message.created",
        sessionId,
        agentType: "codex",
        messageId: "codex-msg-1",
        role: "assistant",
      });

      // REASONING
      persistPartDone({
        type: "part.done",
        sessionId,
        agentType: "codex",
        messageId: "codex-msg-1",
        partId: "cp1",
        part: {
          type: "REASONING",
          id: "cp1",
          sessionId,
          messageId: "codex-msg-1",
          text: "Thinking about the approach...",
          state: "DONE",
        },
      });

      // TEXT intro
      persistPartDone({
        type: "part.done",
        sessionId,
        agentType: "codex",
        messageId: "codex-msg-1",
        partId: "cp2",
        part: {
          type: "TEXT",
          id: "cp2",
          sessionId,
          messageId: "codex-msg-1",
          text: "Let me run a command.",
          state: "DONE",
        },
      });

      // TOOL (shell)
      persistPartDone({
        type: "part.done",
        sessionId,
        agentType: "codex",
        messageId: "codex-msg-1",
        partId: "cp3",
        part: {
          type: "TOOL",
          id: "cp3",
          sessionId,
          messageId: "codex-msg-1",
          toolCallId: "codex-tc1",
          toolName: "shell",
          state: {
            status: "COMPLETED",
            input: "npm test",
            output: "All tests pass",
            time: { start: "t0", end: "t1" },
          },
        },
      });

      // TEXT response
      persistPartDone({
        type: "part.done",
        sessionId,
        agentType: "codex",
        messageId: "codex-msg-1",
        partId: "cp4",
        part: {
          type: "TEXT",
          id: "cp4",
          sessionId,
          messageId: "codex-msg-1",
          text: "All tests pass.",
          state: "DONE",
        },
      });

      persistMessageDone({
        type: "message.done",
        sessionId,
        agentType: "codex",
        messageId: "codex-msg-1",
        stopReason: "end_turn",
        parts: [],
      });

      // ── Verify messages ──
      const messages = db
        .prepare(`SELECT id, role FROM messages WHERE session_id = ?`)
        .all(sessionId) as MessageRow[];

      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe("codex-msg-1");
      expect(messages[0].role).toBe("assistant");

      // ── Verify parts: all 4 linked to the single message ──
      const parts = db
        .prepare(
          `SELECT id, message_id, type, tool_call_id, tool_name FROM parts WHERE session_id = ?`
        )
        .all(sessionId) as PartRow[];

      expect(parts).toHaveLength(4);
      for (const part of parts) {
        expect(part.message_id).toBe("codex-msg-1");
      }

      // Verify part types
      const typeMap = new Map(parts.map((p) => [p.id, p.type]));
      expect(typeMap.get("cp1")).toBe("REASONING");
      expect(typeMap.get("cp2")).toBe("TEXT");
      expect(typeMap.get("cp3")).toBe("TOOL");
      expect(typeMap.get("cp4")).toBe("TEXT");

      // Verify TOOL part has tool metadata
      const toolPart = parts.find((p) => p.type === "TOOL")!;
      expect(toolPart.tool_call_id).toBe("codex-tc1");
      expect(toolPart.tool_name).toBe("shell");
    });
  });

  // ==========================================================================
  // Test 6: persistMessageDone sets stop_reason
  // ==========================================================================

  describe("persistMessageDone stop_reason update", () => {
    it("sets stop_reason on the message by id", () => {
      persistMessageCreated({
        type: "message.created",
        sessionId,
        agentType: "claude",
        messageId: "msg-done-test",
        role: "assistant",
      });

      const result = persistMessageDone({
        type: "message.done",
        sessionId,
        agentType: "claude",
        messageId: "msg-done-test",
        stopReason: "end_turn",
        parts: [],
      });
      expect(result.ok).toBe(true);

      const msg = db
        .prepare(`SELECT stop_reason FROM messages WHERE id = ?`)
        .get("msg-done-test") as { stop_reason: string | null } | undefined;

      expect(msg).toBeDefined();
      expect(msg!.stop_reason).toBe("end_turn");
    });

    it("matches on id column (not agent_message_id)", () => {
      // persistMessageCreated stores the messageId as the row's `id` column.
      // persistMessageDone uses WHERE id = ? to update stop_reason.
      persistMessageCreated({
        type: "message.created",
        sessionId,
        agentType: "claude",
        messageId: "msg-id-match",
        role: "assistant",
      });

      persistMessageDone({
        type: "message.done",
        sessionId,
        agentType: "claude",
        messageId: "msg-id-match",
        stopReason: "tool_use",
        parts: [],
      });

      const msg = db
        .prepare(`SELECT id, stop_reason FROM messages WHERE id = ?`)
        .get("msg-id-match") as MessageRow | undefined;

      expect(msg).toBeDefined();
      expect(msg!.stop_reason).toBe("tool_use");
    });
  });

  // ==========================================================================
  // Test 7: Session message_count trigger fires correctly
  // ==========================================================================

  describe("session message_count trigger", () => {
    it("increments message_count for each inserted message", () => {
      const before = db
        .prepare(`SELECT message_count FROM sessions WHERE id = ?`)
        .get(sessionId) as { message_count: number };
      expect(before.message_count).toBe(0);

      persistMessageCreated({
        type: "message.created",
        sessionId,
        agentType: "claude",
        messageId: "msg-count-1",
        role: "assistant",
      });
      persistMessageCreated({
        type: "message.created",
        sessionId,
        agentType: "claude",
        messageId: "msg-count-2",
        role: "assistant",
      });

      const after = db
        .prepare(`SELECT message_count FROM sessions WHERE id = ?`)
        .get(sessionId) as { message_count: number };
      expect(after.message_count).toBe(2);
    });
  });

  // ==========================================================================
  // Test 8: Part data JSON round-trip
  // ==========================================================================

  describe("part data JSON round-trip", () => {
    it("stores and retrieves the full part object faithfully", () => {
      persistMessageCreated({
        type: "message.created",
        sessionId,
        agentType: "claude",
        messageId: "msg-json",
        role: "assistant",
      });

      const toolPart = {
        type: "TOOL" as const,
        id: "pj1",
        sessionId,
        messageId: "msg-json",
        toolCallId: "tc-json",
        toolName: "Edit",
        state: {
          status: "COMPLETED" as const,
          input: { file: "a.ts", changes: [1, 2, 3] },
          output: "Applied 3 edits",
          title: "Edit a.ts",
          time: { start: "2024-01-01T00:00:00Z", end: "2024-01-01T00:00:02Z" },
        },
        kind: "write" as const,
        locations: [{ path: "a.ts", range: { startLine: 10, endLine: 20 } }],
      };

      persistPartDone({
        type: "part.done",
        sessionId,
        agentType: "claude",
        messageId: "msg-json",
        partId: "pj1",
        part: toolPart,
      });

      const row = db.prepare(`SELECT data FROM parts WHERE id = ?`).get("pj1") as {
        data: string;
      };
      const parsed = JSON.parse(row.data);

      expect(parsed.type).toBe("TOOL");
      expect(parsed.toolCallId).toBe("tc-json");
      expect(parsed.toolName).toBe("Edit");
      expect(parsed.state.status).toBe("COMPLETED");
      expect(parsed.state.input).toEqual({ file: "a.ts", changes: [1, 2, 3] });
      expect(parsed.state.output).toBe("Applied 3 edits");
      expect(parsed.kind).toBe("write");
      expect(parsed.locations).toHaveLength(1);
      expect(parsed.locations[0].path).toBe("a.ts");
    });
  });

  // ==========================================================================
  // Test 9: Missing session returns error (not a crash)
  // ==========================================================================

  describe("missing session FK guard", () => {
    it("returns ok: false when session does not exist", () => {
      const result = persistMessageCreated({
        type: "message.created",
        sessionId: "no-such-session",
        agentType: "claude",
        messageId: "msg-orphan",
        role: "assistant",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("session not found");
      }

      // No row created
      const messages = db.prepare(`SELECT id FROM messages WHERE id = ?`).all("msg-orphan");
      expect(messages).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Test 10: parentToolCallId stored on nested parts
  // ==========================================================================

  describe("parentToolCallId on nested parts", () => {
    it("stores parent_tool_call_id for parts nested inside a tool call", () => {
      persistMessageCreated({
        type: "message.created",
        sessionId,
        agentType: "claude",
        messageId: "msg-nested",
        role: "assistant",
      });

      // A TEXT part nested under a tool call (subagent output)
      persistPartDone({
        type: "part.done",
        sessionId,
        agentType: "claude",
        messageId: "msg-nested",
        partId: "p-nested",
        part: {
          type: "TEXT",
          id: "p-nested",
          sessionId,
          messageId: "msg-nested",
          text: "Subagent response",
          state: "DONE",
          parentToolCallId: "tc-parent",
        },
      });

      const row = db
        .prepare(`SELECT parent_tool_call_id FROM parts WHERE id = ?`)
        .get("p-nested") as PartRow;

      expect(row.parent_tool_call_id).toBe("tc-parent");
    });
  });
});
