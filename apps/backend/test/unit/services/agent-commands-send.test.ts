/**
 * sendMessage and the "no turn was admitted" paths.
 *
 * The user's prompt is NOT written by this command. The engine echoes it back
 * as message.started{role:"user"} and that echo is the single persistence path
 * for the row — so between the send and the echo, the prompt exists in exactly
 * one place: the frontend's optimistic bubble, keyed by the send's turn id.
 *
 * That makes the command's RESULT load-bearing. `handleCommand` (query-engine)
 * answers `accepted: true` when this function returns and `accepted: false`
 * when it throws, and only the false answer runs the composer's rollback. A
 * path that flips the session to "error" but still returns normally leaves the
 * bubble on screen for a turn that never ran and is durable nowhere — which is
 * why the two no-turn guards below must reject, not return.
 *
 * Runs against a real in-memory SQLite, like the stopSession suite.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let canUseDatabase = true;
try {
  new Database(":memory:").close();
} catch {
  canUseDatabase = false;
}
const describeWithDb = canUseDatabase ? describe : describe.skip;

import { SCHEMA_SQL } from "@shared/schema";

const { mockGetDatabase, mockInvalidate } = vi.hoisted(() => ({
  mockGetDatabase: vi.fn(),
  mockInvalidate: vi.fn(),
}));

vi.mock("../../../src/lib/database", () => ({ getDatabase: mockGetDatabase }));
vi.mock("../../../src/services/query-engine", () => ({ invalidate: mockInvalidate }));

import { WireRequestError } from "@zvada/agent-server/client";
import { WIRE_ERROR_CODES } from "@zvada/agent-server/protocol";
import { runCommand } from "../../../src/services/agent/commands";
import * as agentService from "../../../src/services/agent/service";

const SESSION = "sess-send";
/** A session whose workspace row is gone — the worktree-deleted case. */
const ORPHAN = "sess-orphan";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  db.prepare(
    `INSERT INTO repositories (id, name, root_path) VALUES ('r1', 'repo', '/tmp/repo')`
  ).run();
  db.prepare(`INSERT INTO workspaces (id, repository_id, slug) VALUES ('w1', 'r1', 'ws')`).run();
  db.prepare(
    `INSERT INTO sessions (id, workspace_id, agent_harness, status) VALUES (?, 'w1', 'claude-code', 'idle')`
  ).run(SESSION);
  // Seeded with foreign keys OFF on purpose: the scenario IS a dangling
  // workspace_id (the row deleted out from under a live session, or a
  // half-torn-down worktree), which a database with FKs enforced cannot be
  // asked to represent. Enforcement goes straight back on.
  db.pragma("foreign_keys = OFF");
  db.prepare(
    `INSERT INTO sessions (id, workspace_id, agent_harness, status) VALUES (?, 'gone', 'claude-code', 'idle')`
  ).run(ORPHAN);
  db.pragma("foreign_keys = ON");
  return db;
}

const send = (sessionId: string, turnId = "turn-1") =>
  runCommand("sendMessage", {
    sessionId,
    content: "hello",
    model: "claude-opus-4-6",
    agentHarness: "claude-code",
    turnId,
  });

describeWithDb("sendMessage", () => {
  let db: Database.Database;

  const row = (id: string): { status: string; error_message: string | null } =>
    db.prepare(`SELECT status, error_message FROM sessions WHERE id = ?`).get(id) as {
      status: string;
      error_message: string | null;
    };

  beforeEach(() => {
    db = createTestDb();
    mockGetDatabase.mockReturnValue(db);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("admits the turn and answers with the caller's turn id", async () => {
    vi.spyOn(agentService, "isConnected").mockReturnValue(true);
    const startTurn = vi.spyOn(agentService, "startTurn").mockResolvedValue(undefined as never);

    await expect(send(SESSION)).resolves.toEqual({ commandId: "turn-1" });

    expect(startTurn).toHaveBeenCalledOnce();
    // The turn id the caller minted, not a fresh one — it is the key the
    // engine's user echo will come back under.
    expect(startTurn.mock.calls[0][1]).toBe("turn-1");
    expect(row(SESSION).status).toBe("working");
  });

  it("REJECTS the send when the agent server is disconnected", async () => {
    vi.spyOn(agentService, "isConnected").mockReturnValue(false);
    const startTurn = vi.spyOn(agentService, "startTurn");

    // Rejecting is what makes the ack `accepted: false`; returning normally
    // here is the bug — an accepted send for a turn nothing will ever run.
    await expect(send(SESSION)).rejects.toThrow(/disconnected/i);

    expect(startTurn).not.toHaveBeenCalled();
    expect(row(SESSION)).toMatchObject({ status: "error" });
  });

  it("REJECTS the send when the workspace path cannot be resolved", async () => {
    vi.spyOn(agentService, "isConnected").mockReturnValue(true);
    const startTurn = vi.spyOn(agentService, "startTurn");

    await expect(send(ORPHAN)).rejects.toThrow(/workspace/i);

    expect(startTurn).not.toHaveBeenCalled();
    expect(row(ORPHAN)).toMatchObject({ status: "error" });
  });

  // The guards above are the SYNCHRONOUS half. Admission is a round-trip, and
  // it can refuse the turn after every local check has passed — another client
  // won the race to the wire, the server is shutting down, the harness will
  // not spawn. Those verdicts have to reach the ack, which means the send has
  // to await admission. `turn/start` acks the moment the turn is admitted
  // (before the harness runs a step), so awaiting costs a hop, not a turn.
  describe("when the wire refuses admission", () => {
    it("REJECTS the send on turnActive without disturbing the running turn", async () => {
      vi.spyOn(agentService, "isConnected").mockReturnValue(true);
      vi.spyOn(agentService, "startTurn").mockRejectedValue(
        new WireRequestError(
          WIRE_ERROR_CODES.turnActive,
          `session ${SESSION} already has an active turn`
        )
      );

      // Not accepted: returning normally here would ack `accepted: true` for a
      // turn the server refused, stranding the optimistic bubble.
      await expect(send(SESSION)).rejects.toThrow(/still working/i);

      // The turn that IS running belongs to somebody — it must not be
      // flipped to an error status just because our send lost the race.
      expect(row(SESSION)).toMatchObject({ status: "working", error_message: null });
    });

    it("REJECTS the send and errors the session when no turn was admitted", async () => {
      vi.spyOn(agentService, "isConnected").mockReturnValue(true);
      vi.spyOn(agentService, "startTurn").mockRejectedValue(
        new WireRequestError(WIRE_ERROR_CODES.shuttingDown, "server is shutting down")
      );

      await expect(send(SESSION)).rejects.toThrow(/shutting down/i);

      // Nothing is running, so "working" would be a lie that never resolves.
      expect(row(SESSION)).toMatchObject({ status: "error" });
    });

    it("REJECTS the send when the transport dies mid-admission", async () => {
      vi.spyOn(agentService, "isConnected").mockReturnValue(true);
      vi.spyOn(agentService, "startTurn").mockRejectedValue(new Error("socket hang up"));

      await expect(send(SESSION)).rejects.toThrow(/socket hang up/i);

      expect(row(SESSION)).toMatchObject({ status: "error" });
    });
  });

  // `last_user_message_at` is read everywhere as "this workspace has been
  // prompted": the sidebar orders by it, `isFirstSession` tests it for null,
  // and workspace init skips its `git checkout -- .` cleanup while it is set
  // (a prompt sent mid-install must not have the agent's edits wiped). Nothing
  // rolls it back, so a send that never became a turn must never write it.
  describe("the send timestamp", () => {
    const stampOf = (id: string): string | null =>
      (
        db.prepare(`SELECT last_user_message_at FROM sessions WHERE id = ?`).get(id) as {
          last_user_message_at: string | null;
        }
      ).last_user_message_at;

    it("lands once the turn is admitted", async () => {
      vi.spyOn(agentService, "isConnected").mockReturnValue(true);
      vi.spyOn(agentService, "startTurn").mockResolvedValue(undefined as never);

      await send(SESSION);

      expect(stampOf(SESSION)).not.toBeNull();
    });

    it("stays unwritten when the send is rejected before the wire", async () => {
      vi.spyOn(agentService, "isConnected").mockReturnValue(false);

      await expect(send(SESSION)).rejects.toThrow(/disconnected/i);

      // The optimistic "working" flip ran and was undone. A timestamp written
      // beside it had no such undo: the workspace read as permanently
      // prompted, so its init cleanup never ran again.
      expect(stampOf(SESSION)).toBeNull();
    });

    it("stays unwritten when the workspace path cannot be resolved", async () => {
      vi.spyOn(agentService, "isConnected").mockReturnValue(true);

      await expect(send(ORPHAN)).rejects.toThrow(/workspace/i);

      expect(stampOf(ORPHAN)).toBeNull();
    });

    it("leaves the previous turn's stamp alone when admission is refused", async () => {
      db.prepare(`UPDATE sessions SET last_user_message_at = ? WHERE id = ?`).run(
        "2026-08-14T12:00:00.000Z",
        SESSION
      );
      vi.spyOn(agentService, "isConnected").mockReturnValue(true);
      vi.spyOn(agentService, "startTurn").mockRejectedValue(
        new WireRequestError(WIRE_ERROR_CODES.shuttingDown, "server is shutting down")
      );

      await expect(send(SESSION)).rejects.toThrow(/shutting down/i);

      expect(stampOf(SESSION)).toBe("2026-08-14T12:00:00.000Z");
    });
  });

  // The harness column is a session-lifetime binding, so WHEN it moves matters
  // as much as whether it may. The first turn opens an echo-only window: the
  // status is already "working" while `message_count` is still 0, because the
  // user row is written by the engine's echo and not by this command.
  describe("the harness binding", () => {
    const sendWith = (harness: string, turnId: string) =>
      runCommand("sendMessage", {
        sessionId: SESSION,
        content: "hello",
        model: "gpt-5.5-codex",
        agentHarness: harness,
        turnId,
      });

    const harness = (): string =>
      (
        db.prepare(`SELECT agent_harness FROM sessions WHERE id = ?`).get(SESSION) as {
          agent_harness: string;
        }
      ).agent_harness;

    it("moves to the harness of a send that is admitted", async () => {
      vi.spyOn(agentService, "isConnected").mockReturnValue(true);
      const startTurn = vi.spyOn(agentService, "startTurn").mockResolvedValue(undefined as never);

      await expect(sendWith("codex-sdk", "turn-1")).resolves.toEqual({ commandId: "turn-1" });

      expect(harness()).toBe("codex-sdk");
      expect(startTurn.mock.calls[0][2]).toBe("codex-sdk");
    });

    it("does NOT move for a second client's send inside the echo-only window", async () => {
      vi.spyOn(agentService, "isConnected").mockReturnValue(true);
      const startTurn = vi.spyOn(agentService, "startTurn").mockResolvedValue(undefined as never);

      // Client A's send is admitted and running under claude-code. Its user
      // row does not exist yet — the echo has not landed — so the session is
      // exactly what a second client sees: working, with 0 messages.
      await sendWith("claude-code", "turn-a");
      expect(harness()).toBe("claude-code");
      expect(db.prepare(`SELECT message_count FROM sessions WHERE id = ?`).get(SESSION)).toEqual({
        message_count: 0,
      });

      // Client B sends a different harness. The harness lock cannot stop it
      // (0 messages, nothing locked); the active-turn guard has to.
      await expect(sendWith("codex-sdk", "turn-b")).rejects.toThrow(/still working/i);

      // The row still describes the turn that is actually running. Rebinding
      // here would strand the session on a harness that never ran, and the
      // lock would then reject every follow-up send under the real one.
      expect(harness()).toBe("claude-code");
      expect(startTurn).toHaveBeenCalledOnce();
    });

    it("is locked once the session has messages", async () => {
      vi.spyOn(agentService, "isConnected").mockReturnValue(true);
      const startTurn = vi.spyOn(agentService, "startTurn").mockResolvedValue(undefined as never);
      db.prepare(`UPDATE sessions SET message_count = 2 WHERE id = ?`).run(SESSION);

      await expect(sendWith("codex-sdk", "turn-1")).rejects.toThrow(/Cannot switch agent/i);

      expect(harness()).toBe("claude-code");
      expect(startTurn).not.toHaveBeenCalled();
    });
  });

  it("still refuses a send while a turn is running, from every active status", async () => {
    vi.spyOn(agentService, "isConnected").mockReturnValue(true);
    vi.spyOn(agentService, "startTurn").mockResolvedValue(undefined as never);

    for (const status of ["working", "needs_plan_response", "needs_response"]) {
      db.prepare(`UPDATE sessions SET status = ? WHERE id = ?`).run(status, SESSION);
      await expect(send(SESSION)).rejects.toThrow();
      // Refused, not errored — the running turn is untouched.
      expect(row(SESSION).status).toBe(status);
    }
  });
});
