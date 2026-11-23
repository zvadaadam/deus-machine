import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { EventGapError, WireRequestError } from "@zvada/agent-server/client";
import {
  echoMessageId,
  steerMessageId,
  WIRE_ERROR_CODES,
  type TurnCancelResult,
  type LifecycleEvent,
  type TurnEndedEvent,
  type TurnStartParams,
  type TurnSteerParams,
  type TurnSteerResult,
} from "@zvada/agent-server/protocol";
import * as api from "@shared/api/sessions";
import { SCHEMA_SQL } from "@shared/schema";
import * as agent from "../../../src/services/agent/service";
import type { AgentLinkOptions } from "../../../src/services/agent/client";
import sessionHandlers from "../../../src/api/sessions";
import { handle, LOCAL_CALLER, Registry } from "../../../src/api/registry";
import { handleFrame, invalidate, serveOperations } from "../../../src/services/query-engine";
import { subscribe } from "../../../src/services/streams";
import { addConnection, closeAll } from "../../../src/services/ws.service";
import { createDeusHost } from "../../../src/services/assistants/host";
import { answer, clearAll, pendingFor } from "../../../src/services/agent/tool-relay";
import { resolveTurnApps } from "../../../src/services/integrations";
import { operations } from "../../helpers";

const engine = vi.hoisted(() => ({
  open: vi.fn<(options: AgentLinkOptions) => unknown>(),
  startTurn: vi.fn<(params: TurnStartParams & { turnId: string }) => Promise<void>>(),
  steerTurn: vi.fn<(params: TurnSteerParams) => Promise<TurnSteerResult>>(),
  cancelTurn: vi.fn<(sessionId: string, turnId?: string) => Promise<TurnCancelResult>>(),
  respondElicitation: vi.fn(),
  respondPermission: vi.fn(),
  images: true,
}));

vi.mock("../../../src/services/agent/client", () => ({ AgentLink: { open: engine.open } }));
vi.mock("../../../src/lib/database", () => ({ getDatabase: () => db, DB_PATH: ":memory:" }));
vi.mock("../../../src/services/integrations", () => ({
  resolveTurnApps: vi.fn(async () => ({ servers: {}, skipped: [] })),
}));
vi.mock("../../../src/services/pr-snapshot.service", () => ({
  refreshPrSnapshotForSession: () => {},
}));

const run = operations(sessionHandlers);
let db: Database.Database;
let sessionId: string;
let seq: number;
function emit(event: LifecycleEvent) {
  engine.open.mock.calls[0]![0].onEnvelope({ sessionId, seq: ++seq, event });
}
function end(
  turnId: string,
  stopReason: TurnEndedEvent["stopReason"] = "end_turn",
  undeliveredSteers?: string[]
) {
  emit({ type: "turn.ended", sessionId, turnId, stopReason, undeliveredSteers, timestamp: seq });
}
const message = (label: string) => ({
  sessionId,
  content: `Message ${label}`,
  agentHarness: "codex-app-server" as const,
  model: `model-${label}`,
});
const send = (id: string) => run(api.sendMessage, { ...message(id), turnId: id });
const queue = () => run(api.queuedMessages, { sessionId });
const starts = () => engine.startTurn.mock.calls.map(([p]) => p.turnId);
const lastSteerId = () => engine.steerTurn.mock.lastCall![0].steerId!;
const ids = async () => (await queue()).items.map((item) => item.id);
const steer = (label: string) => run(api.steerMessage, message(label));
const steerRow = (id: string) => run(api.steerQueuedMessage, { sessionId, id });
const read = (id: string) => run(api.queuedMessage, { sessionId, id });
const remove = (id: string) => run(api.removeQueuedMessage, { sessionId, id });
const stop = () => run(api.stopSession, { sessionId });
function holdAppSetup() {
  const apps = Promise.withResolvers<Awaited<ReturnType<typeof resolveTurnApps>>>();
  vi.mocked(resolveTurnApps).mockReturnValueOnce(apps.promise);
  return () => apps.resolve({ servers: {}, skipped: [] });
}

function holdAdmission() {
  const ack = Promise.withResolvers<void>();
  engine.startTurn.mockImplementationOnce(({ turnId }) => {
    emit({ type: "turn.started", sessionId, turnId, timestamp: seq });
    return ack.promise;
  });
  return () => ack.resolve();
}

function echo(turnId: string, steerId?: string) {
  emit({
    type: "message.started",
    sessionId,
    turnId,
    messageId: steerId === undefined ? echoMessageId(turnId) : steerMessageId(steerId),
    outputIndex: steerId === undefined ? 0 : 2,
    role: "user",
    timestamp: seq,
  });
}

beforeEach(async () => {
  db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  db.exec(`
    INSERT INTO repositories (id, name, root_path) VALUES ('r', 'repo', '/tmp/repo');
    INSERT INTO workspaces (id, repository_id, slug, state) VALUES ('w', 'r', 'checkout', 'ready');
  `);
  sessionId = crypto.randomUUID();
  db.prepare("INSERT INTO sessions (id, workspace_id) VALUES (?, 'w')").run(sessionId);
  seq = 0;
  serveOperations(new Registry(sessionHandlers));
  engine.images = true;
  engine.open.mockReturnValue({
    startTurn: engine.startTurn,
    cancelTurn: engine.cancelTurn,
    engine: {
      steerTurn: engine.steerTurn,
      respondElicitation: engine.respondElicitation,
      respondPermission: engine.respondPermission,
      onAuthUpdated: () => () => {},
      onCliProgress: () => () => {},
    },
    getAgents: () => [{ type: "codex-app-server", capabilities: { images: engine.images } }],
    isConnected: () => true,
    close: () => {},
  });
  engine.startTurn.mockImplementation(async ({ turnId }) => {
    emit({ type: "turn.started", sessionId, turnId, timestamp: seq });
    echo(turnId);
  });
  engine.steerTurn.mockImplementation(async ({ steerId }) => ({
    outcome: "steered",
    steerId: steerId!,
  }));
  await agent.init();
});

afterEach(async () => {
  vi.useRealTimers();
  clearAll();
  await agent.shutdown();
  closeAll();
  db.exec("DELETE FROM sessions");
  invalidate(["sessions"]);
  db.close();
  vi.resetAllMocks();
});

describe("messages held for a local chat", () => {
  it("starts one message per normal end with that message's settings and pictures", async () => {
    await send("first");
    const parts = [
      { type: "image", mimeType: "image/png", data: "cGljdHVyZQ==" },
      { type: "text", text: "Use this picture" },
    ];
    await expect(
      run(api.sendMessage, {
        ...message("second"),
        turnId: "second",
        content: JSON.stringify(parts),
        permissionMode: "plan",
        thinkingLevel: "high",
      })
    ).resolves.toEqual({ turnId: "second", queued: true });
    await send("third");
    expect(await queue()).toEqual({
      paused: null,
      items: [
        { id: "second", text: "Use this picture", images: 1, state: "waiting" },
        { id: "third", text: "Message third", images: 0, state: "waiting" },
      ],
    });
    end("first");
    await vi.waitFor(() => expect(starts()).toEqual(["first", "second"]));
    expect(engine.startTurn.mock.calls[1]![0]).toMatchObject({
      input: parts,
      config: {
        harness: "codex-app-server",
        model: "model-second",
        permissionMode: "plan",
        thinkingLevel: "high",
      },
    });
    expect(await ids()).toEqual(["third"]);
    end("second");
    await vi.waitFor(() => expect(starts()).toEqual(["first", "second", "third"]));
    expect(engine.startTurn.mock.calls[2]![0].config.model).toBe("model-third");
    expect((await queue()).items).toEqual([]);
  });

  it.each(["end_turn", "cancelled"] as const)(
    "recovers an accepted, unread steer before its RPC resolves (%s)",
    async (reason) => {
      await send("first");
      await send("waiting");
      const reply = Promise.withResolvers<TurnSteerResult>();
      engine.steerTurn.mockReturnValueOnce(reply.promise);
      const receipt = steer("steer");
      const rows = (await queue()).items;
      expect(rows).toMatchObject([
        { text: "Message steer", state: "steering" },
        { id: "waiting", state: "waiting" },
      ]);
      const rowId = rows[0]!.id;
      const attempt = lastSteerId();
      expect(attempt).not.toBe(rowId);
      end("first", reason, [attempt]);
      reply.resolve({ outcome: "steered", steerId: attempt });
      await receipt;
      if (reason === "cancelled") {
        expect(starts()).toEqual(["first"]);
        expect(await queue()).toMatchObject({
          paused: "stopped",
          items: [{ id: rowId, state: "waiting" }, { id: "waiting" }],
        });
      } else {
        await vi.waitFor(() => expect(starts()).toEqual(["first", rowId]));
        expect(await ids()).toEqual(["waiting"]);
      }
    }
  );

  it("the queued turn's end can start its successor before its own quick ack returns", async () => {
    await send("first");
    await send("a");
    await send("b");
    const ack = Promise.withResolvers<void>();
    engine.startTurn.mockImplementationOnce(({ turnId }) => {
      emit({ type: "turn.started", sessionId, turnId, timestamp: seq });
      end(turnId);
      return ack.promise;
    });
    end("first");
    await vi.waitFor(() => expect(starts()).toEqual(["first", "a", "b"]));
    ack.resolve();
    expect(await ids()).toEqual([]);
    expect(agent.liveTurnId(sessionId)).toBe("b");
  });

  it.each(["before", "after"] as const)(
    "shows the sending head through app setup until its echo %s the admission reply",
    async (when) => {
      await send("first");
      await send("head");
      await send("tail");
      end("first", "cancelled");
      const releaseApps = holdAppSetup();
      const admit = holdAdmission();
      const resuming = run(api.resumeQueuedMessages, { sessionId });
      const rows = [
        { id: "head", text: "Message head", images: 0, state: "sending" },
        { id: "tail", text: "Message tail", images: 0, state: "waiting" },
      ];
      expect(starts()).toEqual(["first"]);
      expect((await queue()).items).toEqual(rows);
      expect(await read("head")).toEqual({ content: null });
      expect(await remove("head")).toEqual({ removed: false });
      releaseApps();
      await vi.waitFor(() => expect(starts()).toEqual(["first", "head"]));
      if (when === "after") {
        admit();
        await resuming;
      }
      echo("first");
      echo("head", "unrelated");
      expect((await queue()).items).toEqual(rows);
      echo("head");
      expect(await ids()).toEqual(["tail"]);
      if (when === "before") {
        admit();
        await resuming;
      }
      expect(await ids()).toEqual(["tail"]);
      expect(await read("head")).toEqual({ content: null });
      expect(await remove("head")).toEqual({ removed: false });
      expect((await run(api.messages, { sessionId })).messages).toContainEqual(
        expect.objectContaining({ id: echoMessageId("head"), turn_id: "head", role: "user" })
      );
    }
  );

  it("pauses on Stop before the terminal event and lets a typed message run before Resume", async () => {
    await send("first");
    await send("waiting");
    engine.cancelTurn.mockResolvedValue({ outcome: "cancelled", turnId: "first" });
    await expect(stop()).resolves.toEqual({ unconfirmed: false });
    expect((await queue()).paused).toBe("stopped");
    end("first", "cancelled");
    await expect(send("fresh")).resolves.toEqual({ turnId: "fresh" });
    end("fresh");
    expect(await queue()).toMatchObject({ paused: "stopped", items: [{ id: "waiting" }] });
    await run(api.resumeQueuedMessages, { sessionId });
    expect(starts()).toEqual(["first", "fresh", "waiting"]);
    expect(await queue()).toEqual({ paused: null, items: [] });
  });

  it("keeps a waiting row paused when a normal end arrives before the cancel reply", async () => {
    await send("first");
    await send("waiting");
    const cancel = Promise.withResolvers<TurnCancelResult>();
    engine.cancelTurn.mockReturnValueOnce(cancel.promise);
    const stopping = stop();
    expect(engine.cancelTurn.mock.calls).toEqual([[sessionId, "first"]]);
    expect((await queue()).paused).toBe("stopped");
    end("first");
    expect(await ids()).toEqual(["waiting"]);
    cancel.resolve({ outcome: "cancelled", turnId: "first" });
    await stopping;
    expect(await queue()).toMatchObject({ paused: "stopped", items: [{ id: "waiting" }] });
    expect(starts()).toEqual(["first"]);
  });

  describe("Stop during a queued head's app setup", () => {
    let releaseApps: () => void;
    let stopping: ReturnType<typeof stop>;

    beforeEach(async () => {
      await send("first");
      await send("head");
      await send("next");
      releaseApps = holdAppSetup();
      end("first");
      expect(agent.liveTurnId(sessionId)).toBeUndefined();
      stopping = stop();
      expect(await queue()).toMatchObject({
        paused: "stopped",
        items: [
          { id: "head", state: "sending" },
          { id: "next", state: "waiting" },
        ],
      });
      expect(engine.cancelTurn).not.toHaveBeenCalled();
    });

    it("cancels that head once it is admitted", async () => {
      engine.cancelTurn.mockImplementationOnce(async (_, turnId) => {
        if (!turnId) return { outcome: "no_active_turn" };
        end(turnId, "cancelled");
        return { outcome: "cancelled", turnId };
      });
      releaseApps();
      await expect(stopping).resolves.toEqual({ unconfirmed: false });
      expect(agent.liveTurnId(sessionId)).toBeUndefined();
      expect(engine.cancelTurn.mock.calls).toEqual([[sessionId, "head"]]);
      expect(starts()).toEqual(["first", "head"]);
      expect(await queue()).toMatchObject({ paused: "stopped", items: [{ id: "next" }] });
    });

    it("puts the head back when the wire refuses its registered start", async () => {
      const wire = Promise.withResolvers<void>();
      engine.startTurn.mockReturnValueOnce(wire.promise);
      releaseApps();
      await vi.waitFor(() => expect(starts()).toEqual(["first", "head"]));
      expect(agent.liveTurnId(sessionId)).toBe("head");
      wire.reject(
        new WireRequestError(WIRE_ERROR_CODES.harnessNotAvailable, "Harness unavailable")
      );
      await expect(stopping).resolves.toEqual({ unconfirmed: false });
      expect(agent.liveTurnId(sessionId)).toBeUndefined();
      expect(engine.cancelTurn).not.toHaveBeenCalled();
      expect(await queue()).toMatchObject({
        paused: "stopped",
        items: [
          { id: "head", state: "waiting" },
          { id: "next", state: "waiting" },
        ],
      });
    });

    it("leaves a manual turn working if the head ends before its admission reply", async () => {
      const admit = holdAdmission();
      engine.cancelTurn.mockResolvedValueOnce({ outcome: "no_active_turn" });
      releaseApps();
      await vi.waitFor(() => expect(agent.liveTurnId(sessionId)).toBe("head"));
      expect((await queue()).items[0]).toMatchObject({ id: "head", state: "sending" });
      end("head");
      expect(await ids()).toEqual(["next"]);
      const releaseManual = holdAppSetup();
      const manual = send("manual");
      expect(agent.liveTurnId(sessionId)).toBeUndefined();
      expect(await run(api.session, { sessionId })).toMatchObject({ status: "working" });
      admit();
      await expect(stopping).resolves.toEqual({ unconfirmed: false });
      expect(await run(api.session, { sessionId })).toMatchObject({ status: "working" });
      expect(engine.cancelTurn).not.toHaveBeenCalled();
      releaseManual();
      await manual;
      expect(agent.liveTurnId(sessionId)).toBe("manual");
      expect(await queue()).toMatchObject({ paused: "stopped", items: [{ id: "next" }] });
    });
  });

  it("pauses after a failed turn, and keeps unread steers at the front in request order", async () => {
    await send("first");
    await send("waiting");
    const a = { ...message("a"), turnId: "waiting" };
    const b = { ...message("b"), turnId: "waiting" };
    expect(api.steerMessage.input.parse(a)).not.toHaveProperty("turnId");
    await run(api.steerMessage, a);
    await run(api.steerMessage, b);
    const [firstId, secondId] = await ids();
    expect(new Set([firstId, secondId, "waiting"]).size).toBe(3);
    end(
      "first",
      "error",
      engine.steerTurn.mock.calls.map(([p]) => p.steerId!)
    );
    expect(await queue()).toMatchObject({
      paused: "failed",
      items: [
        { id: firstId, text: a.content, state: "waiting" },
        { id: secondId, text: b.content, state: "waiting" },
        { id: "waiting" },
      ],
    });
    expect(await read(secondId!)).toEqual({ content: b.content });
    expect(await remove(secondId!)).toEqual({ removed: true });
    expect(await ids()).toEqual([firstId, "waiting"]);
    expect(starts()).toEqual(["first"]);
  });

  it.each(["unconfirmed", "disconnected"] as const)(
    "keeps the queue on the %s cancel watchdog",
    async (kind) => {
      vi.useFakeTimers();
      await send("first");
      await send("waiting");
      await steer("a");
      if (kind === "unconfirmed")
        engine.cancelTurn.mockResolvedValue({ outcome: "unconfirmed", turnId: "first" });
      else engine.cancelTurn.mockRejectedValue(new Error("link closed"));
      await expect(stop()).resolves.toEqual({ unconfirmed: true });
      expect((await queue()).paused).toBe("stopped");
      await agent.shutdown();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await queue()).toMatchObject({
        paused: "stopped",
        items: [{ text: "Message a", state: "waiting" }, { id: "waiting" }],
      });
      expect(starts()).toEqual(["first"]);
    }
  );

  it.each(["before", "after"] as const)(
    "recovers unread steers when a gap loses the sending head %s its admission reply",
    async (when) => {
      await send("first");
      await send("head");
      await send("waiting");
      end("first", "cancelled");
      const admit = holdAdmission();
      const resuming = run(api.resumeQueuedMessages, { sessionId });
      await vi.waitFor(() => expect(agent.liveTurnId(sessionId)).toBe("head"));
      if (when === "after") {
        admit();
        await resuming;
      }
      await steer("a");
      const previous = agent.turnWatcher!;
      const interrupted = vi.fn(previous.interrupted);
      agent.provideTurnWatcher({ ...previous, interrupted });
      onTestFinished(() => agent.provideTurnWatcher(previous));
      engine.open.mock.calls[0]![0].onEventGap!({
        sessionId,
        reason: "server_restarted",
        error: new EventGapError("lost"),
      });
      expect(interrupted).toHaveBeenCalledWith(sessionId, undefined);
      if (when === "before") {
        admit();
        await resuming;
      }
      expect(starts()).toEqual(["first", "head"]);
      expect(await queue()).toMatchObject({
        paused: "failed",
        items: [{ text: "Message a", state: "waiting" }, { id: "waiting" }],
      });
      // The engine can replay the terminal after the gap gave up live ownership.
      expect(agent.liveTurnId(sessionId)).toBeUndefined();
      end("head", "cancelled");
      expect((await queue()).paused).toBe("failed");
    }
  );

  it.each([true, false])(
    "steers a queued row using the running harness's images capability (%s)",
    async (images) => {
      engine.images = images;
      await send("first");
      await send("waiting");
      const picture = { type: "image", mimeType: "image/png", data: "cGljdHVyZQ==" };
      await run(api.sendMessage, {
        ...message("picture"),
        turnId: "picture",
        content: JSON.stringify([picture]),
      });
      await expect(steerRow("picture")).resolves.toEqual({ outcome: "steered" });
      const attempt = lastSteerId();
      expect(attempt).not.toBe("picture");
      expect(engine.steerTurn).toHaveBeenCalledWith({
        sessionId,
        turnId: "first",
        steerId: attempt,
        input: images ? [picture] : [{ type: "text", text: expect.stringContaining("omitted") }],
      });
      expect(await ids()).toEqual(["picture", "waiting"]);
      expect(await read("picture")).toEqual({ content: null });
      expect(await remove("picture")).toEqual({ removed: false });
      echo("first", "unrelated");
      expect(await ids()).toEqual(["picture", "waiting"]);
      echo("first", attempt);
      expect(await ids()).toEqual(["waiting"]);
      expect((await run(api.messages, { sessionId })).messages).toContainEqual(
        expect.objectContaining({
          id: steerMessageId(attempt),
          role: "user",
          turn_id: "first",
        })
      );
      end("first");
      await vi.waitFor(() => expect(starts()).toEqual(["first", "waiting"]));
    }
  );

  it("an echoed steer stays delivered when its RPC later throws", async () => {
    await send("first");
    const reply = Promise.withResolvers<TurnSteerResult>();
    engine.steerTurn.mockReturnValueOnce(reply.promise);
    const receipt = steer("a");
    const [rowId] = await ids();
    echo("first", lastSteerId());
    reply.reject(new Error("connection closed"));
    await expect(receipt).resolves.toEqual({ outcome: "steered" });
    await expect(steerRow(rowId!)).resolves.toEqual({ outcome: "gone" });
    expect(engine.steerTurn).toHaveBeenCalledOnce();
    end("first");
    expect(await ids()).toEqual([]);
    expect(starts()).toEqual(["first"]);
  });

  it("a steer echoed after its RPC timed out never runs a second time", async () => {
    await send("first");
    engine.steerTurn.mockRejectedValueOnce(new Error("timed out"));
    await expect(steer("a")).resolves.toEqual({ outcome: "steered" });
    expect((await queue()).items).toMatchObject([{ text: "Message a", state: "steering" }]);
    echo("first", lastSteerId());
    expect(await ids()).toEqual([]);
    end("first");
    expect(await run(api.session, { sessionId })).toMatchObject({ status: "idle" });
    expect(starts()).toEqual(["first"]);
  });

  it.each(["end_turn", "cancelled"] as const)(
    "a timed-out steer still unread at %s returns to the front once",
    async (reason) => {
      await send("first");
      await send("waiting");
      engine.steerTurn.mockRejectedValueOnce(new Error("timed out"));
      await expect(steer("a")).resolves.toEqual({ outcome: "steered" });
      const rows = (await queue()).items;
      expect(rows).toMatchObject([{ text: "Message a", state: "steering" }, { id: "waiting" }]);
      const rowId = rows[0]!.id;
      end("first", reason, reason === "cancelled" ? [lastSteerId()] : undefined);
      if (reason === "cancelled") {
        expect(await queue()).toMatchObject({
          paused: "stopped",
          items: [{ id: rowId, state: "waiting" }, { id: "waiting" }],
        });
        await run(api.resumeQueuedMessages, { sessionId });
      }
      await vi.waitFor(() => expect(starts()).toEqual(["first", rowId]));
      expect(await ids()).toEqual(["waiting"]);
      end(rowId);
      await vi.waitFor(() => expect(starts()).toEqual(["first", rowId, "waiting"]));
    }
  );

  it("steers the same unread row into a later turn with a fresh engine id", async () => {
    await send("first");
    await send("row");
    await steerRow("row");
    const firstAttempt = lastSteerId();
    end("first", "cancelled", [firstAttempt]);
    await send("fresh");
    await steerRow("row");
    const nextAttempt = lastSteerId();
    expect(new Set(["row", firstAttempt, nextAttempt]).size).toBe(3);
    // A second window still saw the Steer action. It cannot start a third attempt.
    await expect(steerRow("row")).resolves.toEqual({ outcome: "steered" });
    expect(engine.steerTurn).toHaveBeenCalledTimes(2);
    echo("first", firstAttempt);
    expect((await queue()).items).toMatchObject([{ id: "row", state: "steering" }]);
    echo("fresh", nextAttempt);
    expect(await ids()).toEqual([]);
    end("fresh");
    expect(starts()).toEqual(["first", "fresh"]);
  });

  it("reads a waiting row's full content without removing it, then removes it once", async () => {
    await send("first");
    const content = JSON.stringify([
      { type: "image", mimeType: "image/png", data: "cGljdHVyZQ==" },
    ]);
    const queued = await run(api.sendMessage, { ...message("image"), content });
    expect(await read(queued.turnId)).toEqual({ content });
    expect(await ids()).toEqual([queued.turnId]);
    expect(await remove(queued.turnId)).toEqual({ removed: true });
    expect(await read(queued.turnId)).toEqual({ content: null });
    expect(await remove(queued.turnId)).toEqual({ removed: false });
    expect(await steerRow(queued.turnId)).toEqual({ outcome: "gone" });
    end("first");
    expect(starts()).toEqual(["first"]);
  });

  it.each(["no_active_turn", "unsupported"] as const)(
    "moves a steer the engine refused to the head (%s)",
    async (outcome) => {
      await send("first");
      await send("waiting");
      engine.steerTurn.mockResolvedValue({ outcome });
      await expect(steer("a")).resolves.toEqual({ outcome: "queued" });
      const rows = (await queue()).items;
      expect(rows).toMatchObject([{ text: "Message a", state: "waiting" }, { id: "waiting" }]);
      end("first");
      await vi.waitFor(() => expect(starts()).toEqual(["first", rows[0]!.id]));
    }
  );

  it("sends a steer as its own turn if the working chat has just gone idle", async () => {
    await send("first");
    end("first");
    await expect(steer("a")).resolves.toEqual({ outcome: "sent" });
    expect(engine.steerTurn).not.toHaveBeenCalled();
    expect(engine.startTurn.mock.calls.map(([turn]) => turn.input)).toEqual([
      "Message first",
      "Message a",
    ]);
  });

  it("a no_active_turn reply arriving after the end cannot enqueue a steer twice", async () => {
    await send("first");
    await send("waiting");
    const reply = Promise.withResolvers<TurnSteerResult>();
    engine.steerTurn.mockReturnValueOnce(reply.promise);
    const receipt = steer("a");
    const [rowId] = await ids();
    end("first");
    reply.resolve({ outcome: "no_active_turn" });
    await receipt;
    await vi.waitFor(() => expect(starts()).toEqual(["first", rowId]));
    expect(await ids()).toEqual(["waiting"]);
  });

  it.each(["needs_response", "needs_plan_response"])(
    "a %s card queues a steer without moving a row",
    async (status) => {
      await send("first");
      await send("a");
      await send("b");
      db.prepare("UPDATE sessions SET status = ? WHERE id = ?").run(status, sessionId);
      await expect(steer("c")).resolves.toEqual({ outcome: "queued" });
      await expect(steerRow("b")).resolves.toEqual({ outcome: "queued" });
      expect(engine.steerTurn).not.toHaveBeenCalled();
      expect((await queue()).items).toMatchObject([
        { id: "a" },
        { id: "b" },
        { text: "Message c" },
      ]);
    }
  );

  it.each(["cancelled", "end_turn"] as const)(
    "withdraws the ending turn's question and leaves the queued successor's plan open on replay (%s)",
    async (reason) => {
      const frames: unknown[] = [];
      const window = addConnection(
        { close() {}, send: (frame) => frames.push(JSON.parse(String(frame))) },
        null
      );
      subscribe(window, "cards", api.toolRequests, { sessionId });
      await send("first");
      emit({
        type: "elicitation.requested",
        sessionId,
        turnId: "first",
        requestId: "question",
        mode: "question",
        message: "Which branch?",
        questions: [{ id: "q", question: "Which branch?" }],
        timestamp: seq,
      });
      const [question] = pendingFor(sessionId);
      expect(question?.method).toBe("askUserQuestion");
      await expect(send("next")).resolves.toEqual({ turnId: "next", queued: true });
      engine.startTurn.mockImplementationOnce(async ({ turnId }) => {
        emit({ type: "turn.started", sessionId, turnId, timestamp: seq });
        emit({
          type: "permission.requested",
          sessionId,
          turnId,
          requestId: "plan",
          title: "Implement the plan?",
          options: [{ optionId: "plan", name: "Keep planning", kind: "allow_once" }],
          timestamp: seq,
        });
      });
      if (reason === "cancelled") {
        engine.cancelTurn.mockResolvedValueOnce({ outcome: "cancelled", turnId: "first" });
        await stop();
      }
      emit({
        type: "elicitation.resolved",
        sessionId,
        turnId: "first",
        requestId: "question",
        outcome: { action: "cancel" },
        timestamp: seq,
      });
      end("first", reason);
      expect(pendingFor(sessionId)).toEqual([]);
      expect(frames).toContainEqual({
        type: "q:event",
        id: "cards",
        event: "toolRequests",
        data: { type: "cancel", sessionId, requestId: question!.requestId },
      });
      if (reason === "cancelled") await run(api.resumeQueuedMessages, { sessionId });
      await vi.waitFor(() =>
        expect(pendingFor(sessionId)).toMatchObject([{ method: "exitPlanMode" }])
      );
      expect(engine.respondElicitation).toHaveBeenCalledWith(sessionId, "question", {
        action: "cancel",
      });
      const plan = pendingFor(sessionId);
      const beforeReplay = frames.length;
      end("first", reason);
      expect(answer(question!.requestId, { result: { answers: ["main"] } })).toBe(false);
      expect(pendingFor(sessionId)).toEqual(plan);
      expect(frames).toHaveLength(beforeReplay);
      expect(await run(api.session, { sessionId })).toMatchObject({
        status: "needs_plan_response",
      });
      expect(starts()).toEqual(["first", "next"]);
      end("next");
      expect(pendingFor(sessionId)).toEqual([]);
      await vi.waitFor(() =>
        expect(engine.respondPermission).toHaveBeenCalledWith(sessionId, "plan", {
          outcome: "cancelled",
        })
      );
    }
  );

  it("a held id acknowledges only its original content, including while paused and idle", async () => {
    await send("first");
    await send("again");
    const different = () =>
      run(api.sendMessage, { ...message("again"), turnId: "again", content: "Another task" });
    await expect(different()).rejects.toThrow(/different message/i);
    await steerRow("again");
    await expect(send("again")).resolves.toEqual({ turnId: "again", queued: true });
    await expect(different()).rejects.toThrow(/different message/i);
    end("first", "cancelled", [lastSteerId()]);
    await expect(send("again")).resolves.toEqual({ turnId: "again", queued: true });
    await expect(different()).rejects.toThrow(/different message/i);
    expect(starts()).toEqual(["first"]);
    expect(await queue()).toMatchObject({
      paused: "stopped",
      items: [{ id: "again", text: "Message again" }],
    });
  });

  it("holds 20 sending, steering and waiting rows and refuses a 21st send or composer steer", async () => {
    await send("first");
    await send("head");
    engine.startTurn.mockImplementationOnce(async ({ turnId }) => {
      emit({ type: "turn.started", sessionId, turnId, timestamp: seq });
    });
    end("first");
    await vi.waitFor(() => expect(agent.liveTurnId(sessionId)).toBe("head"));
    await steer("unread");
    const waiting = Array.from({ length: 18 }, (_, i) => `waiting-${i}`);
    for (const id of waiting) await send(id);
    const rows = (await queue()).items;
    expect(rows.map((row) => row.state)).toEqual([
      "sending",
      "steering",
      ...waiting.map(() => "waiting"),
    ]);
    const refusal =
      "This chat already has 20 messages waiting. Remove one, or wait for the agent to take them.";
    await expect(send("overflow")).rejects.toThrow(refusal);
    await expect(steer("overflow")).rejects.toThrow(refusal);
    expect(engine.steerTurn).toHaveBeenCalledOnce();
    expect((await queue()).items).toEqual(rows);

    await expect(send("waiting-0")).resolves.toEqual({ turnId: "waiting-0", queued: true });
    await expect(steerRow("waiting-0")).resolves.toEqual({ outcome: "steered" });
    echo("head");
    await send("last");
    end("head", "cancelled");
    expect(await ids()).toEqual([rows[1]!.id, ...waiting, "last"]);
    await expect(send("manual")).resolves.toEqual({ turnId: "manual" });
  });

  it.each(["before", "after"] as const)(
    "queues two callers of a losing admission once when the winner ends %s the busy reply",
    async (when) => {
      const admission = Promise.withResolvers<void>();
      engine.startTurn.mockReturnValueOnce(admission.promise);
      const receipts = Promise.all([send("loser"), send("loser")]);
      await vi.waitFor(() => expect(starts()).toEqual(["loser"]));
      expect(await ids()).toEqual([]);
      await agent.startTurn(sessionId, "winner", "codex-app-server", "winning turn", {
        cwd: "/tmp/repo",
      });
      if (when === "before") end("winner");
      admission.reject(new WireRequestError(WIRE_ERROR_CODES.turnActive, "busy"));
      expect(await receipts).toEqual([
        { turnId: "loser", queued: true },
        { turnId: "loser", queued: true },
      ]);
      if (when === "after") {
        expect(await ids()).toEqual(["loser"]);
        end("winner");
      }
      await vi.waitFor(() => expect(starts()).toEqual(["loser", "winner", "loser"]));
      expect(await ids()).toEqual([]);
    }
  );

  it("pauses rows accepted during an admission that later fails", async () => {
    const reply = Promise.withResolvers<void>();
    engine.startTurn.mockReturnValueOnce(reply.promise);
    const first = send("first");
    await send("waiting");
    await vi.waitFor(() => expect(starts()).toEqual(["first"]));
    reply.reject(new Error("engine unavailable"));
    await expect(first).rejects.toThrow("engine unavailable");
    expect(await queue()).toMatchObject({ paused: "failed", items: [{ id: "waiting" }] });
  });

  it.each(["failed", "busy"] as const)(
    "puts a %s queued start back at the head",
    async (failure) => {
      await send("first");
      await send("a");
      await send("b");
      engine.startTurn.mockRejectedValueOnce(
        failure === "failed"
          ? new Error("engine unavailable")
          : new WireRequestError(WIRE_ERROR_CODES.turnActive, "busy")
      );
      end("first");
      await vi.waitFor(async () =>
        expect(await queue()).toMatchObject({
          paused: failure === "failed" ? "failed" : null,
          items: [
            { id: "a", state: "waiting" },
            { id: "b", state: "waiting" },
          ],
        })
      );
      if (failure === "failed") await run(api.resumeQueuedMessages, { sessionId });
      else {
        await agent.startTurn(sessionId, "other", "codex-app-server", "winning turn", {
          cwd: "/tmp/repo",
        });
        end("other");
      }
      const expected = failure === "failed" ? ["first", "a", "a"] : ["first", "a", "other", "a"];
      await vi.waitFor(() => expect(starts()).toEqual(expected));
      expect(await ids()).toEqual(["b"]);
    }
  );

  it("retries the head when the competing turn ended before the busy admission reply", async () => {
    await send("first");
    await send("next");
    const reply = Promise.withResolvers<void>();
    engine.startTurn.mockReturnValueOnce(reply.promise);
    end("first");
    await vi.waitFor(() => expect(starts()).toEqual(["first", "next"]));
    // Its native admission wins while our local claim is still pending.
    engine.startTurn.mockResolvedValueOnce(undefined);
    await agent.startTurn(sessionId, "winner", "codex-app-server", "winning turn", {
      cwd: "/tmp/repo",
    });
    emit({ type: "turn.started", sessionId, turnId: "winner", timestamp: seq });
    end("winner");
    reply.reject(new WireRequestError(WIRE_ERROR_CODES.turnActive, "busy"));
    await vi.waitFor(() => expect(starts()).toEqual(["first", "next", "winner", "next"]));
    expect(await ids()).toEqual([]);
  });

  it("keeps cloud messages on strict admission, including a cloud chat without a provider id", async () => {
    db.exec("UPDATE workspaces SET kind = 'cloud'; UPDATE sessions SET status = 'working'");
    for (const op of [api.sendMessage, api.steerMessage]) {
      await expect(run(op, message("cloud"))).rejects.toThrow(
        "The agent is still working — wait for the current turn to finish."
      );
    }
    expect(await ids()).toEqual([]);
    expect(engine.steerTurn).not.toHaveBeenCalled();
  });

  it("the operator still hears busy while a person's message waits", async () => {
    await send("first");
    await send("person");
    const caller = {
      kind: "external",
      id: "window",
      speaksAs: "person",
      auth: LOCAL_CALLER,
    } as const;
    await expect(
      createDeusHost().send(caller, sessionId, {
        turnId: "operator",
        message: "follow up",
        origin: { kind: "person" },
      })
    ).rejects.toMatchObject({ refusal: { code: "busy" } });
    expect(await ids()).toEqual(["person"]);
  });

  it.each(["archive", "hide", "delete"])(
    "discards waiting messages and in-flight steer replies on %s",
    async (action) => {
      await send("first");
      await send("waiting");
      const reply = Promise.withResolvers<TurnSteerResult>();
      engine.steerTurn.mockReturnValueOnce(reply.promise);
      const receipt = steer("a");
      if (action === "archive") db.exec("UPDATE workspaces SET state = 'archived'");
      if (action === "hide") db.exec("UPDATE sessions SET is_hidden = 1");
      if (action === "delete") db.exec("DELETE FROM sessions");
      invalidate(["workspaces", "sessions"]);
      expect(await queue()).toEqual({ paused: null, items: [] });
      reply.resolve({ outcome: "unsupported" });
      await receipt;
      db.exec("UPDATE workspaces SET state = 'ready'; UPDATE sessions SET is_hidden = 0");
      expect(await ids()).toEqual([]);
      expect(starts()).toEqual(["first"]);
    }
  );

  it("publishes the old end before admitting the next turn and pushes the queue to both windows", async () => {
    await send("first");
    const connect = (chatId = sessionId) => {
      const frames: {
        id: string;
        data?: {
          status?: string;
          items?: api.QueuedMessages["items"];
          envelope?: { event: { type: string; messageId?: string } };
        };
      }[] = [];
      const id = addConnection(
        { close() {}, send: (frame) => frames.push(JSON.parse(String(frame))) },
        null
      );
      for (const resource of ["queuedMessages", "sessionEvents", "session"]) {
        handleFrame(id, {
          type: "q:subscribe",
          id: resource,
          resource,
          params: { sessionId: chatId },
        });
      }
      return frames;
    };
    const first = connect();
    const otherChat = await run(api.createSession, { workspaceId: "w" });
    const unrelated = connect(otherChat.id);
    expect(unrelated.find((f) => f.id === "queuedMessages")?.data?.items).toEqual([]);
    unrelated.length = 0;
    await send("next");
    const second = connect();
    for (const frames of [first, second]) {
      expect(frames.filter((f) => f.id === "queuedMessages").at(-1)?.data?.items).toMatchObject([
        { id: "next" },
      ]);
      frames.length = 0;
    }
    end("first");
    await vi.waitFor(() => expect(starts()).toEqual(["first", "next"]));
    expect(unrelated).toEqual([]);
    for (const frames of [first, second]) {
      const ended = frames.findIndex((f) => f.data?.envelope?.event.type === "turn.ended");
      expect(ended).toBeGreaterThanOrEqual(0);
      expect(
        frames.findIndex((f) => f.id === "session" && f.data?.status === "working")
      ).toBeGreaterThan(ended);
      const sending = frames.findIndex((f) => f.data?.items?.[0]?.state === "sending");
      const echoed = frames.findIndex(
        (f) => f.data?.envelope?.event.messageId === echoMessageId("next")
      );
      expect(sending).toBeGreaterThan(ended);
      expect(echoed).toBeGreaterThan(sending);
      expect(frames.findIndex((f) => f.data?.items?.length === 0)).toBeGreaterThan(echoed);
    }
  });

  it("a workspace's sessions subscription keeps its scope when a caller passes an extra sessionId", () => {
    const send = vi.fn();
    const connection = addConnection({ close() {}, send }, null);
    handleFrame(connection, {
      type: "q:subscribe",
      id: "workspaceChats",
      resource: "sessions",
      params: { workspaceId: "w", sessionId: "other" },
    });
    send.mockClear();
    invalidate(["sessions"], { sessionIds: [sessionId] });
    expect(JSON.parse(send.mock.calls[0]![0])).toMatchObject({
      type: "q:snapshot",
      id: "workspaceChats",
      data: [expect.objectContaining({ id: sessionId })],
    });
  });

  it("scopes a live read by the session in its declaration, whatever its name", () => {
    const perChat = { ...api.sessions, input: api.session.input };
    const snapshot = vi.fn(() => []);
    serveOperations(new Registry([handle(perChat, snapshot)]));
    const connection = addConnection({ close() {}, send() {} }, null);
    handleFrame(connection, {
      type: "q:subscribe",
      id: "rows",
      resource: perChat.name,
      params: { sessionId },
    });
    snapshot.mockClear();
    invalidate([perChat.name], { sessionIds: ["another-chat"] });
    expect(snapshot).not.toHaveBeenCalled();
    invalidate([perChat.name], { sessionIds: [sessionId] });
    expect(snapshot).toHaveBeenCalledOnce();
  });
});
