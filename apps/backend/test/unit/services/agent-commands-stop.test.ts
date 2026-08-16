/**
 * stopSession and the cancel outcome union.
 *
 * PROTOCOL §8: "unconfirmed" is NOT a cancel — the interrupt was dispatched but
 * never acknowledged, so the agent may still be writing files. Forcing the
 * session to "idle" there showed a finished session while work continued, and
 * the real turn.ended then flipped it back. Runs against a real in-memory
 * SQLite: the command's whole observable effect is one UPDATE.
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

import { runCommand } from "../../../src/services/agent/commands";
import * as agentService from "../../../src/services/agent/service";

const SESSION = "sess-stop";

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

describeWithDb("stopSession", () => {
  let db: Database.Database;

  const status = (): string =>
    (db.prepare(`SELECT status FROM sessions WHERE id = ?`).get(SESSION) as { status: string })
      .status;

  beforeEach(() => {
    db = createTestDb();
    mockGetDatabase.mockReturnValue(db);
    vi.spyOn(agentService, "isConnected").mockReturnValue(true);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("goes idle when the harness CONFIRMED the interrupt", async () => {
    vi.spyOn(agentService, "stopSession").mockResolvedValue({
      outcome: "cancelled",
      turnId: "turn-1",
    });

    await runCommand("stopSession", { sessionId: SESSION });

    expect(status()).toBe("idle");
  });

  it("goes idle when there was no active turn to cancel", async () => {
    vi.spyOn(agentService, "stopSession").mockResolvedValue({ outcome: "no_active_turn" });

    await runCommand("stopSession", { sessionId: SESSION });

    expect(status()).toBe("idle");
  });

  it("leaves an UNCONFIRMED cancel working — turn.ended is the source of truth", async () => {
    vi.spyOn(agentService, "stopSession").mockResolvedValue({
      outcome: "unconfirmed",
      turnId: "turn-1",
    });

    const result = await runCommand("stopSession", { sessionId: SESSION });

    expect(result).toEqual({ unconfirmed: true });
    expect(status()).toBe("working");
  });

  it("the unconfirmed watchdog settles a session no turn.ended ever reached", async () => {
    vi.spyOn(agentService, "stopSession").mockResolvedValue({
      outcome: "unconfirmed",
      turnId: "turn-1",
    });

    await runCommand("stopSession", { sessionId: SESSION });
    await vi.advanceTimersByTimeAsync(20_000);

    expect(status()).toBe("error");
    expect(
      db.prepare(`SELECT error_message FROM sessions WHERE id = ?`).get(SESSION)
    ).toMatchObject({ error_message: expect.stringContaining("never confirmed") });
  });

  it.each(["needs_plan_response", "needs_response"])(
    "the watchdog also settles an unconfirmed cancel issued from %s",
    async (startingStatus) => {
      // A stop is legal from every status that means "a turn is running", and
      // the overlay statuses are where users hit it most — cancelling a plan
      // approval or a question. Matching only 'working' left those sessions
      // parked forever behind an overlay with no agent to answer it.
      db.prepare(`UPDATE sessions SET status = ? WHERE id = ?`).run(startingStatus, SESSION);
      vi.spyOn(agentService, "stopSession").mockResolvedValue({
        outcome: "unconfirmed",
        turnId: "turn-1",
      });

      await runCommand("stopSession", { sessionId: SESSION });
      expect(status()).toBe(startingStatus);

      await vi.advanceTimersByTimeAsync(20_000);

      expect(status()).toBe("error");
    }
  );

  it("the watchdog never stomps on a status turn.ended already settled", async () => {
    vi.spyOn(agentService, "stopSession").mockResolvedValue({
      outcome: "unconfirmed",
      turnId: "turn-1",
    });

    await runCommand("stopSession", { sessionId: SESSION });
    // turn.ended lands while the watchdog is pending.
    db.prepare(`UPDATE sessions SET status = 'idle' WHERE id = ?`).run(SESSION);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(status()).toBe("idle");
  });

  it("the watchdog leaves a turn that STARTED AFTER the cancelled one alone", async () => {
    // The whole cycle fits inside the 15s grace window: cancel goes
    // unconfirmed, the turn ends anyway, the user sends again. Status alone
    // cannot tell the new turn from the old one — both are "working" — so a
    // status-only watchdog fails a healthy run 15 seconds into it.
    vi.spyOn(agentService, "stopSession").mockResolvedValue({
      outcome: "unconfirmed",
      turnId: "turn-1",
    });
    const liveTurn = vi.spyOn(agentService, "liveTurnId").mockReturnValue("turn-1");

    await runCommand("stopSession", { sessionId: SESSION });

    // turn-1 ends, turn-2 is admitted, and the session is working again.
    liveTurn.mockReturnValue("turn-2");
    db.prepare(`UPDATE sessions SET status = 'working' WHERE id = ?`).run(SESSION);

    await vi.advanceTimersByTimeAsync(20_000);

    expect(status()).toBe("working");
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it("the watchdog still fires when the cancelled turn is the one still live", async () => {
    vi.spyOn(agentService, "stopSession").mockResolvedValue({
      outcome: "unconfirmed",
      turnId: "turn-1",
    });
    vi.spyOn(agentService, "liveTurnId").mockReturnValue("turn-1");

    await runCommand("stopSession", { sessionId: SESSION });
    await vi.advanceTimersByTimeAsync(20_000);

    expect(status()).toBe("error");
  });

  it("the watchdog still fires when the handler is GONE (link dropped)", async () => {
    // `liveTurnId` returns undefined for "no live turn" AND for "no handler to
    // ask". The second is exactly when a session gets stranded on 'working'
    // with no agent behind it, so absence of evidence must not suppress the
    // fallback — only a positively DIFFERENT live turn does.
    vi.spyOn(agentService, "stopSession").mockResolvedValue({
      outcome: "unconfirmed",
      turnId: "turn-1",
    });
    const liveTurn = vi.spyOn(agentService, "liveTurnId").mockReturnValue("turn-1");

    await runCommand("stopSession", { sessionId: SESSION });
    liveTurn.mockReturnValue(undefined);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(status()).toBe("error");
  });

  it("still goes idle when the wire call itself fails — nothing will report a turn.ended", async () => {
    vi.spyOn(agentService, "stopSession").mockRejectedValue(new Error("socket closed"));

    await runCommand("stopSession", { sessionId: SESSION });

    expect(status()).toBe("idle");
  });
});
