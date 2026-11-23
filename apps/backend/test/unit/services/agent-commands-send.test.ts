// Turn admission through the person's send operation, and the strict sender's busy refusal.
// The engine echo writes the prompt. The operation tells the composer whether it was
// admitted, queued for a later turn, or refused.

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
vi.mock("../../../src/services/query-engine", () => ({
  invalidate: mockInvalidate,
  onInvalidate: () => () => {},
}));

import { WireRequestError } from "@zvada/agent-server/client";
import { WIRE_ERROR_CODES } from "@zvada/agent-server/protocol";
import * as api from "@shared/api/sessions";
import type { InputOf } from "@shared/api/op";
import { operations } from "../../helpers";
import sessionHandlers from "../../../src/api/sessions";
import * as agentService from "../../../src/services/agent/service";
import { sendMessage as sendStrict } from "../../../src/services/agent/turns";
import * as cloudDriver from "../../../src/services/agent/cloud/driver";
import { applyCloudStatus } from "../../../src/services/workspace-lifecycle";

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

// Through the operation, as a client's frame arrives: input checked, then the send.
const run = operations(sessionHandlers);
const sendMessage = (input: InputOf<typeof api.sendMessage>) => run(api.sendMessage, input);

const send = (sessionId: string, turnId = "turn-1") =>
  sendMessage({
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

    await expect(send(SESSION)).resolves.toEqual({ turnId: "turn-1" });

    expect(startTurn).toHaveBeenCalledOnce();
    // The turn id the caller minted, not a fresh one — it is the key the
    // engine's user echo will come back under.
    expect(startTurn.mock.calls[0][1]).toBe("turn-1");
    expect(row(SESSION).status).toBe("working");
  });

  it("the same turn asked again: the first's answer once it is known, its state left as it is", async () => {
    vi.spyOn(agentService, "isConnected").mockReturnValue(true);
    let admit!: () => void;
    const startTurn = vi
      .spyOn(agentService, "startTurn")
      .mockImplementation(() => new Promise<never>((resolve) => (admit = resolve as () => void)));
    const first = send(SESSION);
    // Still pending: the retry waits for it, and is not acknowledged before it.
    let answered = false;
    const retry = send(SESSION).then((r) => ((answered = true), r));
    await new Promise((r) => setTimeout(r, 10));
    expect(answered).toBe(false);
    admit();
    await expect(first).resolves.toEqual({ turnId: "turn-1" });
    await expect(retry).resolves.toEqual({ turnId: "turn-1" });
    // A different request under the same id is a conflict, never acknowledged.
    await expect(
      sendMessage({
        sessionId: SESSION,
        content: "other",
        model: "claude-opus-4-6",
        agentHarness: "claude-code",
        turnId: "turn-1",
      })
    ).rejects.toThrow("A different message");
    expect(startTurn).toHaveBeenCalledOnce();
  });

  it("an ended turn asked again answers from its stored echo, and is not flipped back to working", async () => {
    db.prepare("INSERT INTO turns (session_id, turn_id, ended_at) VALUES (?, 'turn-1', 1)").run(
      SESSION
    );
    db.prepare(
      "INSERT INTO messages (id, session_id, role, turn_id) VALUES ('m1', ?, 'user', 'turn-1')"
    ).run(SESSION);
    db.prepare(
      "INSERT INTO parts (id, message_id, session_id, type, data) VALUES ('p1', 'm1', ?, 'text', ?)"
    ).run(SESSION, JSON.stringify({ type: "text", text: "hello" }));
    const startTurn = vi.spyOn(agentService, "startTurn");
    await expect(send(SESSION)).resolves.toEqual({ turnId: "turn-1" });
    expect(row(SESSION).status).toBe("idle");
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("the same turn asked again after its admission failed is sent anew", async () => {
    vi.spyOn(agentService, "isConnected").mockReturnValue(true);
    const startTurn = vi
      .spyOn(agentService, "startTurn")
      .mockRejectedValueOnce(new Error("spawn failed"))
      .mockResolvedValueOnce(undefined as never);
    await expect(send(SESSION, "turn-9")).rejects.toThrow();
    db.prepare("UPDATE sessions SET status = 'idle' WHERE id = ?").run(SESSION);
    await expect(send(SESSION, "turn-9")).resolves.toEqual({ turnId: "turn-9" });
    expect(startTurn).toHaveBeenCalledTimes(2);
  });

  it("F1: a stop during admission, then a refused start, leaves no turn row: a retry runs anew", async () => {
    vi.spyOn(agentService, "isConnected").mockReturnValue(true);
    let refuse!: (err: unknown) => void;
    const startTurn = vi
      .spyOn(agentService, "startTurn")
      .mockImplementationOnce(() => new Promise<never>((_, reject) => (refuse = reject)))
      .mockResolvedValueOnce(undefined as never);
    const first = send(SESSION, "turn-7");
    // The stop sees the turn as live (registered before the engine's verdict) and claims it.
    vi.spyOn(agentService, "liveTurnId").mockReturnValue("turn-7");
    vi.spyOn(agentService, "stopSession").mockResolvedValue({ outcome: "cancelled" } as never);
    await run(api.stopSession, { sessionId: SESSION });
    refuse(new WireRequestError(WIRE_ERROR_CODES.shuttingDown, "server is shutting down"));
    await expect(first).rejects.toThrow();
    // No turn of that id exists, so a read has no running turn to show.
    expect(db.prepare("SELECT COUNT(*) AS n FROM turns WHERE turn_id = 'turn-7'").get()).toEqual({
      n: 0,
    });
    vi.mocked(agentService.liveTurnId).mockReturnValue(undefined);
    db.prepare("UPDATE sessions SET status = 'idle' WHERE id = ?").run(SESSION);
    await expect(send(SESSION, "turn-7")).resolves.toEqual({ turnId: "turn-7" });
    expect(startTurn).toHaveBeenCalledTimes(2);
  });

  it("keeps the typed busy refusal for strict callers", async () => {
    db.prepare("UPDATE sessions SET status = 'working' WHERE id = ?").run(SESSION);
    await expect(
      sendStrict({
        sessionId: SESSION,
        content: "hello",
        model: "opus",
        agentHarness: "claude-code",
      })
    ).rejects.toMatchObject({ name: "ChatBusyError" });
  });

  it.each([
    ["read-only", "Unsupported permission mode"],
    ["bypassPermissions", "Unsupported permission mode"],
    ["", "Unsupported permission mode"],
    // Not even a string: refused where the frame arrives, before the send runs.
    [null, "sendMessage: permissionMode"],
    [123, "sendMessage: permissionMode"],
  ])(
    "rejects an unsupported permission mode %s before changing session state",
    async (permissionMode, message) => {
      const startTurn = vi.spyOn(agentService, "startTurn");
      const before = db.prepare("SELECT * FROM sessions WHERE id = ?").get(SESSION);

      await expect(
        sendMessage({
          sessionId: SESSION,
          content: "hello",
          model: "gpt-6-astra",
          agentHarness: "codex-app-server",
          permissionMode: permissionMode as string,
        })
      ).rejects.toThrow(message);

      expect(startTurn).not.toHaveBeenCalled();
      expect(mockInvalidate).not.toHaveBeenCalled();
      expect(db.prepare("SELECT * FROM sessions WHERE id = ?").get(SESSION)).toEqual(before);
    }
  );

  it("refuses a Gemini plan before admitting the turn or switching the chat's agent", async () => {
    const startTurn = vi.spyOn(agentService, "startTurn");
    const before = db.prepare("SELECT * FROM sessions WHERE id = ?").get(SESSION);
    await expect(
      sendMessage({
        sessionId: SESSION,
        content: "plan the migration",
        agentHarness: "gemini",
        model: "gemini-4-neon",
        permissionMode: "plan",
      })
    ).rejects.toThrow("Gemini does not offer plan mode.");
    expect(startTurn).not.toHaveBeenCalled();
    expect(db.prepare("SELECT * FROM sessions WHERE id = ?").get(SESSION)).toEqual(before);
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
    it("queues the person's send on turnActive without disturbing the running turn", async () => {
      vi.spyOn(agentService, "isConnected").mockReturnValue(true);
      vi.spyOn(agentService, "startTurn").mockRejectedValue(
        new WireRequestError(
          WIRE_ERROR_CODES.turnActive,
          `session ${SESSION} already has an active turn`
        )
      );

      await expect(send(SESSION)).resolves.toEqual({ turnId: "turn-1", queued: true });
      expect(await run(api.removeQueuedMessage, { sessionId: SESSION, id: "turn-1" })).toEqual({
        content: "hello",
      });

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
    const sendWith = (
      harness: InputOf<typeof api.sendMessage>["agentHarness"],
      turnId: string,
      model = "gpt-5.5-codex"
    ) =>
      sendMessage({
        sessionId: SESSION,
        content: "hello",
        model,
        agentHarness: harness,
        turnId,
      });

    const harness = (): string =>
      (
        db.prepare(`SELECT agent_harness FROM sessions WHERE id = ?`).get(SESSION) as {
          agent_harness: string;
        }
      ).agent_harness;

    it.each([
      ["codex-app-server", "gpt-5.5-codex"],
      ["gemini", "gemini-4-neon"],
    ] as const)("opens the first turn on the selected %s model", async (agent, model) => {
      vi.spyOn(agentService, "isConnected").mockReturnValue(true);
      const startTurn = vi.spyOn(agentService, "startTurn").mockResolvedValue(undefined as never);

      await expect(sendWith(agent, "turn-1", model)).resolves.toEqual({ turnId: "turn-1" });
      expect(harness()).toBe(agent);
      expect(startTurn).toHaveBeenCalledWith(
        SESSION,
        "turn-1",
        agent,
        "hello",
        expect.objectContaining({ model })
      );
    });

    it("refuses a different harness at queue admission before the first echo", async () => {
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

      await expect(sendWith("codex-app-server", "turn-b")).rejects.toThrow(/Cannot switch agent/i);
      await expect(
        run(api.steerMessage, {
          sessionId: SESSION,
          turnId: "turn-b",
          agentHarness: "codex-app-server",
          model: "gpt-5.5-codex",
          content: "hello",
        })
      ).rejects.toThrow(/Cannot switch agent/i);
      expect(await run(api.queuedMessages, { sessionId: SESSION })).toEqual({
        paused: null,
        items: [],
      });
      expect(harness()).toBe("claude-code");
      expect(startTurn).toHaveBeenCalledOnce();
    });

    it("restamps the cloud twin's harness on the first-send choice", async () => {
      // The driver's connect-time stamp ran when the workspace pipeline
      // pre-opened the socket — under the default harness — and the open
      // socket short-circuits every later connect. The first send is the only
      // place the real choice can reach discovery.
      vi.spyOn(agentService, "isConnected").mockReturnValue(true);
      vi.spyOn(cloudDriver, "hasLiveCloudSession").mockReturnValue(true);
      vi.spyOn(cloudDriver, "startCloudTurn").mockResolvedValue(undefined as never);
      const push = vi.spyOn(cloudDriver, "pushCloudSessionFacts").mockImplementation(() => {});
      db.prepare(`UPDATE workspaces SET kind = 'cloud', state = 'ready' WHERE id = 'w1'`).run();

      await expect(
        sendMessage({
          sessionId: SESSION,
          content: "hello",
          model: "gpt-6.1-sol",
          agentHarness: "codex-app-server",
          thinkingLevel: "medium",
          turnId: "turn-1",
        })
      ).resolves.toEqual({ turnId: "turn-1" });

      expect(harness()).toBe("codex-app-server");
      expect(push).toHaveBeenCalledWith(SESSION, { harness: "codex-app-server" });
    });

    it("is locked once the session has messages", async () => {
      vi.spyOn(agentService, "isConnected").mockReturnValue(true);
      const startTurn = vi.spyOn(agentService, "startTurn").mockResolvedValue(undefined as never);
      db.prepare(`UPDATE sessions SET message_count = 2 WHERE id = ?`).run(SESSION);

      await expect(sendWith("codex-app-server", "turn-1")).rejects.toThrow(/Cannot switch agent/i);

      expect(harness()).toBe("claude-code");
      expect(startTurn).not.toHaveBeenCalled();
    });
  });

  describe("cloud turns", () => {
    const cloudSend = (thinkingLevel: unknown, model = "opus") =>
      sendMessage({
        sessionId: SESSION,
        content: "hello",
        model,
        agentHarness: "claude-code",
        turnId: "turn-1",
        ...(thinkingLevel !== undefined ? { thinkingLevel: thinkingLevel as string } : {}),
      });

    beforeEach(() => {
      db.prepare(`UPDATE workspaces SET kind = 'cloud', state = 'ready' WHERE id = 'w1'`).run();
      vi.spyOn(cloudDriver, "hasLiveCloudSession").mockReturnValue(true);
    });

    it.each([
      {
        report: null,
        stage: "paused",
        lastLine: { status: "paused", reason: "wake failed — try again" },
      },
      { report: "resuming", stage: "resuming", lastLine: { status: "resuming" } },
      { report: "running", stage: null, lastLine: { status: "running" } },
      { report: "paused", stage: "paused", lastLine: { status: "paused" } },
    ])(
      "keeps the row and chat line from a $report report when a send fails",
      async ({ report, stage, lastLine }) => {
        db.prepare(
          "UPDATE workspaces SET init_stage='paused', current_session_id=? WHERE id='w1'"
        ).run(SESSION);
        const announce = vi.spyOn(cloudDriver, "announceCloudEnv");
        vi.spyOn(cloudDriver, "startCloudTurn").mockImplementation(async () => {
          expect(db.prepare("SELECT init_stage FROM workspaces WHERE id='w1'").get()).toEqual({
            init_stage: "resuming",
          });
          if (report) {
            applyCloudStatus("w1", { status: report });
            cloudDriver.announceCloudEnv("w1", SESSION, { status: report });
          }
          throw new Error("send refused");
        });
        await expect(cloudSend("high")).rejects.toThrow("send refused");
        expect(db.prepare("SELECT state, init_stage FROM workspaces WHERE id='w1'").get()).toEqual({
          state: "ready",
          init_stage: stage,
        });
        expect(announce).toHaveBeenCalledTimes(2);
        expect(announce).toHaveBeenLastCalledWith("w1", SESSION, lastLine);
      }
    );

    it("hands the driver the turn's harness, model and thinking level, in the platform's vocabulary", async () => {
      const startCloudTurn = vi
        .spyOn(cloudDriver, "startCloudTurn")
        .mockResolvedValue(undefined as never);

      // `max` is AGNT's level; the engine deus runs locally has no such level.
      await expect(cloudSend("max")).resolves.toEqual({ turnId: "turn-1" });

      expect(startCloudTurn).toHaveBeenCalledWith(SESSION, "turn-1", "hello", {
        harness: "claude-code",
        model: "opus",
        thinkingLevel: "max",
      });
    });

    it.each([
      [undefined, "opus", /thinking level/],
      ["extreme", "opus", /thinking level/],
      // Claude's alias for whatever the account's default is — no model at all.
      ["high", "default", /model/],
    ])(
      "refuses a send naming thinking %s on model %s before changing anything",
      async (thinkingLevel, model, message) => {
        const startCloudTurn = vi.spyOn(cloudDriver, "startCloudTurn");
        const before = db.prepare("SELECT * FROM sessions WHERE id = ?").get(SESSION);

        await expect(cloudSend(thinkingLevel, model)).rejects.toThrow(message);

        expect(startCloudTurn).not.toHaveBeenCalled();
        expect(mockInvalidate).not.toHaveBeenCalled();
        expect(db.prepare("SELECT * FROM sessions WHERE id = ?").get(SESSION)).toEqual(before);
      }
    );
  });

  it("queues a person's message from every active status", async () => {
    vi.spyOn(agentService, "isConnected").mockReturnValue(true);
    vi.spyOn(agentService, "startTurn").mockResolvedValue(undefined as never);

    for (const status of ["working", "needs_plan_response", "needs_response"]) {
      db.prepare(`UPDATE sessions SET status = ? WHERE id = ?`).run(status, SESSION);
      await expect(send(SESSION)).resolves.toEqual({ turnId: "turn-1", queued: true });
      await run(api.removeQueuedMessage, { sessionId: SESSION, id: "turn-1" });
      expect(row(SESSION).status).toBe(status);
    }
  });
});
