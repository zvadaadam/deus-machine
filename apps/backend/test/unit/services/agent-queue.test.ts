import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventGapError, WireRequestError } from "@zvada/agent-server/client";
import {
  createSteerEchoParts,
  createUserEchoParts,
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
const steer = (label: string) =>
  run(api.steerMessage, { ...message(label), turnId: agent.liveTurnId(sessionId) });
const steerRow = (id: string) =>
  run(api.steerQueuedMessage, { sessionId, id, turnId: agent.liveTurnId(sessionId) });
const move = (id: string, before: string | null) =>
  run(api.moveQueuedMessage, { sessionId, id, before });
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

function* echoFrames(
  turnId: string,
  input: TurnStartParams["input"],
  steerId?: string
): Generator<LifecycleEvent> {
  const messageId = steerId === undefined ? echoMessageId(turnId) : steerMessageId(steerId);
  const stamp = { sessionId, turnId, messageId, timestamp: seq };
  const outputIndex = steerId === undefined ? 0 : 2;
  yield { type: "message.started", ...stamp, outputIndex, role: "user" };
  const parts =
    steerId === undefined
      ? createUserEchoParts(input, turnId)
      : createSteerEchoParts(input, steerId);
  for (const [partIndex, part] of parts.entries()) {
    yield {
      type: "message.part",
      ...stamp,
      outputIndex,
      partIndex,
      part: { ...part, sessionId, messageId },
    };
  }
  yield { type: "message.ended", ...stamp };
}

function echo(
  turnId: string,
  steerId?: string,
  input: TurnStartParams["input"] = message(turnId).content
) {
  for (const frame of echoFrames(turnId, input, steerId)) emit(frame);
}

function question(turnId: string) {
  emit({
    type: "elicitation.requested",
    sessionId,
    turnId,
    requestId: "question",
    mode: "question",
    message: "Which branch?",
    questions: [{ id: "q", question: "Which branch?" }],
    timestamp: seq,
  });
}

function plan(turnId: string) {
  emit({
    type: "permission.requested",
    sessionId,
    turnId,
    requestId: "plan",
    title: "Implement the plan?",
    options: [{ optionId: "plan", name: "Keep planning", kind: "allow_once" }],
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
  engine.startTurn.mockImplementation(async ({ turnId, input }) => {
    emit({ type: "turn.started", sessionId, turnId, timestamp: seq });
    echo(turnId, undefined, input);
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
  it.each(["composer", "row"] as const)(
    "holds a late %s steer for its own turn when the displayed turn has ended",
    async (source) => {
      await send("A");
      await send("B");
      await send("tail");
      if (source === "row") await send("follow-up");
      const turnId = agent.liveTurnId(sessionId);
      const request =
        source === "row"
          ? () => run(api.steerQueuedMessage, { sessionId, id: "follow-up", turnId })
          : () => run(api.steerMessage, { ...message("follow-up"), turnId });
      end("A");
      await vi.waitFor(() => expect(agent.liveTurnId(sessionId)).toBe("B"));
      await expect(request()).resolves.toEqual({ outcome: "queued" });
      expect(engine.steerTurn).not.toHaveBeenCalled();
      expect((await queue()).items).toMatchObject([
        { text: "Message follow-up", state: "waiting" },
        { id: "tail" },
      ]);
      expect(starts()).toEqual(["A", "B"]);
    }
  );

  it("puts a steer from a client without a displayed turn first in the queue", async () => {
    await send("active");
    await send("waiting");
    await send("row");
    await run(api.steerQueuedMessage, { sessionId, id: "row" });
    await run(api.steerMessage, message("composer"));
    expect(engine.steerTurn).not.toHaveBeenCalled();
    expect((await queue()).items).toMatchObject([
      { text: "Message composer" },
      { id: "row" },
      { id: "waiting" },
    ]);
  });

  it.each([
    ["question", question],
    ["plan", plan],
  ] as const)(
    "puts named stale steers first while the next turn has a %s card",
    async (_, showCard) => {
      await send("A");
      await send("B");
      await send("waiting");
      await send("row");
      end("A");
      await vi.waitFor(() => expect(agent.liveTurnId(sessionId)).toBe("B"));
      showCard("B");
      const [card] = pendingFor(sessionId);
      await run(api.steerQueuedMessage, { sessionId, id: "row", turnId: "A" });
      await run(api.steerMessage, { ...message("stale"), turnId: "A" });
      await run(api.steerMessage, message("unnamed"));
      expect((await queue()).items.map((item) => item.text)).toEqual([
        "Message stale",
        "Message row",
        "Message waiting",
        "Message unnamed",
      ]);
      expect(engine.steerTurn).not.toHaveBeenCalled();
      expect(pendingFor(sessionId)).toEqual([card]);
    }
  );

  it("delivers C, A, B after moving C before A while a turn runs", async () => {
    await send("working");
    for (const id of ["A", "B", "C"]) await send(id);
    await expect(move("C", "A")).resolves.toEqual({ moved: true });
    expect(await ids()).toEqual(["C", "A", "B"]);
    expect(starts()).toEqual(["working"]);
    end("working");
    await vi.waitFor(() => expect(agent.liveTurnId(sessionId)).toBe("C"));
    end("C");
    await vi.waitFor(() => expect(agent.liveTurnId(sessionId)).toBe("A"));
    end("A");
    await vi.waitFor(() => expect(starts()).toEqual(["working", "C", "A", "B"]));
  });

  it("moves a waiting row to the end without resuming a paused queue", async () => {
    await send("working");
    await send("A");
    await send("B");
    end("working", "cancelled");
    await expect(move("A", null)).resolves.toEqual({ moved: true });
    expect(await queue()).toMatchObject({ paused: "stopped", items: [{ id: "B" }, { id: "A" }] });
    expect(starts()).toEqual(["working"]);
  });

  it("refuses moves of or before a missing, sending or steering row", async () => {
    await send("first");
    for (const id of ["head", "steer", "tail"]) await send(id);
    engine.startTurn.mockResolvedValueOnce(undefined); // The head has not echoed yet.
    end("first");
    await vi.waitFor(() => expect(agent.liveTurnId(sessionId)).toBe("head"));
    await steerRow("steer");
    const before = await queue();
    for (const id of ["gone", "head", "steer"]) {
      await expect(move(id, null)).resolves.toEqual({ moved: false });
      await expect(move("tail", id)).resolves.toEqual({ moved: false });
    }
    expect(await queue()).toEqual(before);
    expect(starts()).toEqual(["first", "head"]);
  });

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
      echo(turnId);
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

  it.each(["error", "end_turn", "cancelled"] as const)(
    "keeps an admitted head without a complete echo for an explicit Resume after %s",
    async (reason) => {
      await send("first");
      await send("head");
      await send("tail");
      end("first", "cancelled");
      const admit = holdAdmission();
      const resuming = run(api.resumeQueuedMessages, { sessionId });
      await vi.waitFor(() => expect(starts()).toEqual(["first", "head"]));
      admit();
      await resuming;
      if (reason === "end_turn") {
        for (const frame of echoFrames("head", "Message head")) {
          if (frame.type !== "message.ended") emit(frame);
        }
      }
      end("head", reason);
      expect(await queue()).toMatchObject({
        paused: reason === "cancelled" ? "stopped" : "failed",
        items: [
          { id: "head", state: "waiting" },
          { id: "tail", state: "waiting" },
        ],
      });
      expect(await read("head")).toEqual({ content: "Message head" });
      expect(starts()).toEqual(["first", "head"]);

      engine.startTurn.mockResolvedValueOnce(undefined);
      await run(api.resumeQueuedMessages, { sessionId });
      const retry = engine.startTurn.mock.lastCall![0];
      expect(starts()).toEqual(["first", "head", retry.turnId]);
      expect(retry.turnId).not.toBe("head");
      expect(retry).toMatchObject({ input: "Message head", config: { model: "model-head" } });
      emit({ type: "turn.started", sessionId, turnId: retry.turnId, timestamp: seq });
      echo("head");
      expect((await queue()).items).toMatchObject([
        { id: "head", state: "sending" },
        { id: "tail" },
      ]);
      echo(retry.turnId, undefined, "Message head");
      expect(await ids()).toEqual(["tail"]);
      end(retry.turnId);
      await vi.waitFor(() => expect(starts()).toEqual(["first", "head", retry.turnId, "tail"]));
    }
  );

  it("keeps an admitted head sending through unnamed and unconfirmed interruptions", async () => {
    await send("first");
    await send("head");
    end("first", "cancelled");
    const admit = holdAdmission();
    const resuming = run(api.resumeQueuedMessages, { sessionId });
    await vi.waitFor(() => expect(starts()).toEqual(["first", "head"]));
    await agent.shutdown();
    admit();
    await resuming;
    expect(await queue()).toMatchObject({
      paused: null,
      items: [{ id: "head", state: "sending" }],
    });
    agent.notifyTurnInterrupted(sessionId, undefined, true);
    agent.notifyTurnInterrupted(sessionId, "head", false);
    expect(await queue()).toMatchObject({
      paused: "failed",
      items: [{ id: "head", state: "sending" }],
    });
    end("head", "error");
    expect(await queue()).toMatchObject({
      paused: "failed",
      items: [{ id: "head", state: "waiting" }],
    });
    expect(starts()).toEqual(["first", "head"]);
  });

  it("keeps a live head sending when its admission reply fails before its echo", async () => {
    await send("first");
    await send("head");
    end("first", "cancelled");
    const wire = Promise.withResolvers<void>();
    engine.startTurn.mockReturnValueOnce(wire.promise);
    const resuming = run(api.resumeQueuedMessages, { sessionId });
    await vi.waitFor(() => expect(starts()).toEqual(["first", "head"]));
    emit({ type: "turn.started", sessionId, turnId: "head", timestamp: seq });
    wire.reject(new Error("connection lost"));
    await resuming;
    expect((await queue()).paused).toBe("failed");
    await run(api.resumeQueuedMessages, { sessionId });
    expect(starts()).toEqual(["first", "head"]);
    expect((await queue()).items).toMatchObject([{ id: "head", state: "sending" }]);
    echo("head");
    expect(await ids()).toEqual([]);
  });

  it.each(["echo", "error end"] as const)(
    "keeps the delivery established by the %s when the head's admission reply is lost",
    async (seen) => {
      await send("first");
      await send("head");
      await send("tail");
      end("first", "cancelled");
      const wire = Promise.withResolvers<void>();
      engine.startTurn.mockReturnValueOnce(wire.promise);
      const resuming = run(api.resumeQueuedMessages, { sessionId });
      await vi.waitFor(() => expect(starts()).toEqual(["first", "head"]));
      emit({ type: "turn.started", sessionId, turnId: "head", timestamp: seq });
      if (seen === "echo") echo("head");
      else end("head", "error");
      wire.reject(new Error("connection lost"));
      await resuming;
      expect(starts()).toEqual(["first", "head"]);
      expect(await ids()).toEqual(seen === "echo" ? ["tail"] : ["head", "tail"]);
      await run(api.resumeQueuedMessages, { sessionId });
      const retry = engine.startTurn.mock.lastCall![0];
      expect(starts()).toHaveLength(3);
      expect(retry.turnId).not.toBe("head");
      expect(retry.input).toBe(seen === "echo" ? "Message tail" : "Message head");
    }
  );

  it("keeps a confirmed stop's final echo when a second Stop finds the turn gone", async () => {
    await send("first");
    await send("waiting");
    await steer("follow-up");
    const attempt = lastSteerId();
    engine.cancelTurn
      .mockResolvedValueOnce({ outcome: "cancelled", turnId: "first" })
      .mockResolvedValueOnce({ outcome: "no_active_turn" });
    await expect(stop()).resolves.toEqual({ unconfirmed: false });
    expect(await queue()).toMatchObject({
      paused: "stopped",
      items: [{ state: "steering" }, { id: "waiting" }],
    });
    echo("first", attempt, message("follow-up").content);
    await expect(stop()).resolves.toEqual({ unconfirmed: false });
    const { messages } = await run(api.messages, { sessionId });
    expect(messages.filter((row) => row.id === steerMessageId(attempt))).toHaveLength(1);
    expect(await ids()).toEqual(["waiting"]);
    await expect(send("fresh")).resolves.toEqual({ turnId: "fresh" });
    end("fresh");
    expect(await queue()).toMatchObject({ paused: "stopped", items: [{ id: "waiting" }] });
    await run(api.resumeQueuedMessages, { sessionId });
    expect(starts()).toEqual(["first", "fresh", "waiting"]);
    expect(await queue()).toEqual({ paused: null, items: [] });
  });

  it("immediately returns an unechoed head and closes its card when Stop finds no active turn", async () => {
    await send("first");
    await send("head");
    await send("tail");
    end("first", "cancelled");
    engine.startTurn.mockResolvedValueOnce(undefined);
    await run(api.resumeQueuedMessages, { sessionId });
    question("head");
    expect(pendingFor(sessionId)).toHaveLength(1);
    expect((await queue()).items[0]).toMatchObject({ id: "head", state: "sending" });

    engine.cancelTurn.mockResolvedValueOnce({ outcome: "no_active_turn" });
    await expect(stop()).resolves.toEqual({ unconfirmed: false });
    expect(engine.cancelTurn.mock.calls).toEqual([[sessionId, "head"]]);
    expect(agent.liveTurnId(sessionId)).toBeUndefined();
    expect(pendingFor(sessionId)).toEqual([]);
    expect(await run(api.session, { sessionId })).toMatchObject({ status: "idle" });
    expect(await queue()).toMatchObject({
      paused: "stopped",
      items: [
        { id: "head", state: "waiting" },
        { id: "tail", state: "waiting" },
      ],
    });
    await run(api.resumeQueuedMessages, { sessionId });
    expect(await run(api.session, { sessionId })).toMatchObject({ status: "working" });
    const retry = engine.startTurn.mock.lastCall![0];
    expect(starts()).toEqual(["first", "head", retry.turnId]);
    expect(retry.turnId).not.toBe("head");
    expect(retry.input).toBe("Message head");
    expect(await ids()).toEqual(["tail"]);

    engine.cancelTurn.mockResolvedValueOnce({ outcome: "cancelled", turnId: retry.turnId });
    await stop();
    end(retry.turnId, "cancelled");
    expect(await queue()).toMatchObject({ paused: "stopped", items: [{ id: "tail" }] });
  });

  it("holds new sends and Resume until the confirmed turn's end", async () => {
    await send("A");
    await send("B");
    engine.cancelTurn.mockResolvedValueOnce({ outcome: "cancelled", turnId: "A" });
    await expect(stop()).resolves.toEqual({ unconfirmed: false });
    await run(api.resumeQueuedMessages, { sessionId });
    await expect(send("C")).resolves.toEqual({ turnId: "C", queued: true });
    expect(starts()).toEqual(["A"]);
    expect(await run(api.session, { sessionId })).toMatchObject({ status: "working" });
    end("A", "cancelled");
    expect(await run(api.session, { sessionId })).toMatchObject({ status: "idle" });
    expect(await queue()).toMatchObject({ paused: "stopped", items: [{ id: "B" }, { id: "C" }] });
    await run(api.resumeQueuedMessages, { sessionId });
    expect(starts()).toEqual(["A", "B"]);
    expect(await run(api.session, { sessionId })).toMatchObject({ status: "working" });
  });

  it("settles a confirmed stop with no end and keeps the late end off its successor", async () => {
    vi.useFakeTimers();
    const frames: unknown[] = [];
    const window = addConnection(
      { close() {}, send: (frame) => frames.push(JSON.parse(String(frame))) },
      null
    );
    subscribe(window, "transcript", api.sessionEvents, { sessionId });
    await send("first");
    await send("A");
    await send("tail");
    engine.startTurn.mockImplementationOnce(async ({ turnId }) => {
      emit({ type: "turn.started", sessionId, turnId, timestamp: seq });
    });
    end("first");
    await vi.waitFor(() => expect(agent.liveTurnId(sessionId)).toBe("A"));
    await steer("unread");
    question("A");
    engine.cancelTurn.mockResolvedValueOnce({ outcome: "cancelled", turnId: "A" });
    await expect(stop()).resolves.toEqual({ unconfirmed: false });
    expect((await queue()).items.map((item) => item.state)).toEqual([
      "sending",
      "steering",
      "waiting",
    ]);
    expect(await run(api.session, { sessionId })).toMatchObject({ status: "needs_response" });

    await vi.advanceTimersByTimeAsync(15_000);
    expect(frames).toContainEqual(expect.objectContaining({ type: "q:reset", id: "transcript" }));
    expect(agent.liveTurnId(sessionId)).toBeUndefined();
    expect(pendingFor(sessionId)).toEqual([]);
    expect(await run(api.session, { sessionId })).toMatchObject({
      status: "idle",
      error_message: null,
    });
    expect((await run(api.messages, { sessionId })).turns).toContainEqual(
      expect.objectContaining({ turnId: "A", stopReason: "cancelled" })
    );
    expect(await queue()).toMatchObject({
      paused: "stopped",
      items: [
        { id: "A", state: "waiting" },
        { text: "Message unread", state: "waiting" },
        { id: "tail" },
      ],
    });

    const release = holdAppSetup();
    const resume = run(api.resumeQueuedMessages, { sessionId });
    emit({
      type: "turn.ended",
      sessionId,
      turnId: "A",
      stopReason: "cancelled",
      timestamp: seq,
      cost: 0.25,
    });
    expect(await run(api.session, { sessionId })).toMatchObject({ status: "working" });
    expect((await queue()).paused).toBeNull();
    expect((await run(api.messages, { sessionId })).turns).toContainEqual(
      expect.objectContaining({ turnId: "A", cost: 0.25 })
    );
    release();
    await resume;
    expect(starts()).toHaveLength(3);
    expect(agent.liveTurnId(sessionId)).toBe(starts()[2]);
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

  it("keeps a resumed queue unpaused when the previous Stop reply arrives during app setup", async () => {
    await send("A");
    await send("B");
    await send("C");
    const cancel = Promise.withResolvers<TurnCancelResult>();
    engine.cancelTurn.mockReturnValueOnce(cancel.promise);
    const stopping = stop();
    expect(engine.cancelTurn.mock.calls).toEqual([[sessionId, "A"]]);
    end("A");

    const releaseApps = holdAppSetup();
    const resuming = run(api.resumeQueuedMessages, { sessionId });
    expect(agent.liveTurnId(sessionId)).toBeUndefined();
    cancel.resolve({ outcome: "no_active_turn" });
    await stopping;
    expect(await run(api.session, { sessionId })).toMatchObject({ status: "working" });
    const duringSetup = await queue();
    releaseApps();
    await resuming;
    expect(duringSetup).toMatchObject({
      paused: null,
      items: [
        { id: "B", state: "sending" },
        { id: "C", state: "waiting" },
      ],
    });
    end("B");
    await vi.waitFor(() => expect(starts()).toEqual(["A", "B", "C"]));
  });

  it.each(["direct", "operator"] as const)(
    "refuses the %s send on Stop without waiting for its apps",
    async (sender) => {
      const releaseApps = holdAppSetup();
      const sending =
        sender === "direct"
          ? send("starting")
          : createDeusHost().send(
              { kind: "external", id: "window", speaksAs: "person", auth: LOCAL_CALLER },
              sessionId,
              { turnId: "starting", message: "hello", origin: { kind: "person" } }
            );
      await vi.waitFor(() => expect(resolveTurnApps).toHaveBeenCalled());
      expect(await run(api.session, { sessionId })).toMatchObject({ status: "working" });
      expect(agent.liveTurnId(sessionId)).toBeUndefined();
      const reason = "Stopped before it started.";
      await Promise.all([
        expect(sending).rejects.toMatchObject(
          sender === "direct"
            ? { statusCode: 409, message: reason }
            : { code: "unsupported", message: expect.stringContaining(reason) }
        ),
        expect(stop()).resolves.toEqual({ unconfirmed: false }),
      ]);
      expect(starts()).toEqual([]);
      expect(engine.cancelTurn).not.toHaveBeenCalled();
      expect(await run(api.session, { sessionId })).toMatchObject({
        status: "idle",
        error_message: null,
        last_user_message_at: null,
      });
      expect(await run(api.messages, { sessionId })).toMatchObject({ messages: [], turns: [] });

      await send("next");
      releaseApps();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(starts()).toEqual(["next"]);
      expect(agent.liveTurnId(sessionId)).toBe("next");
      expect(await run(api.session, { sessionId })).toMatchObject({ status: "working" });
    }
  );

  describe("Stop while a queued head is starting", () => {
    let releaseApps: () => void;

    beforeEach(async () => {
      await send("first");
      await send("head");
      await send("next");
      releaseApps = holdAppSetup();
      end("first");
      expect(agent.liveTurnId(sessionId)).toBeUndefined();
    });

    it("returns the head first and pauses without waiting for its apps", async () => {
      await expect(stop()).resolves.toEqual({ unconfirmed: false });
      expect(await run(api.session, { sessionId })).toMatchObject({
        status: "idle",
        error_message: null,
      });
      expect(await queue()).toMatchObject({
        paused: "stopped",
        items: [
          { id: "head", state: "waiting" },
          { id: "next", state: "waiting" },
        ],
      });
      expect(starts()).toEqual(["first"]);
      expect(engine.cancelTurn).not.toHaveBeenCalled();

      await run(api.resumeQueuedMessages, { sessionId });
      expect(engine.startTurn.mock.calls.map(([p]) => p.input)).toEqual([
        "Message first",
        "Message head",
      ]);
      expect(await ids()).toEqual(["next"]);
    });

    it("waits for the head's wire reply before cancelling it", async () => {
      const admit = holdAdmission();
      engine.cancelTurn.mockImplementationOnce(async (_, turnId) => {
        if (!turnId) return { outcome: "no_active_turn" };
        end(turnId, "cancelled");
        return { outcome: "cancelled", turnId };
      });
      releaseApps();
      await vi.waitFor(() => expect(starts()).toEqual(["first", "head"]));
      const stopping = stop();
      expect(engine.cancelTurn).not.toHaveBeenCalled();
      echo("head");
      admit();
      await expect(stopping).resolves.toEqual({ unconfirmed: false });
      expect(agent.liveTurnId(sessionId)).toBeUndefined();
      expect(engine.cancelTurn.mock.calls).toEqual([[sessionId, "head"]]);
      expect(starts()).toEqual(["first", "head"]);
      expect(await queue()).toMatchObject({ paused: "stopped", items: [{ id: "next" }] });
    });

    it("settles the chat and returns the head if the wire times out during Stop", async () => {
      const wire = Promise.withResolvers<void>();
      engine.startTurn.mockReturnValueOnce(wire.promise);
      releaseApps();
      await vi.waitFor(() => expect(starts()).toEqual(["first", "head"]));
      expect(agent.liveTurnId(sessionId)).toBe("head");
      const stopping = stop();
      wire.reject(
        new WireRequestError(WIRE_ERROR_CODES.internalError, "request timed out: turn/start")
      );
      await expect(stopping).resolves.toEqual({ unconfirmed: false });
      expect(agent.liveTurnId(sessionId)).toBeUndefined();
      expect(engine.cancelTurn).not.toHaveBeenCalled();
      expect(await run(api.session, { sessionId })).toMatchObject({
        status: "error",
        error_message: "request timed out: turn/start",
      });
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
      const stopping = stop();
      expect((await queue()).items[0]).toMatchObject({ id: "head", state: "sending" });
      echo("head");
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
    const a = { ...message("a"), turnId: "first" };
    const b = { ...message("b"), turnId: "first" };
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

  describe("a queue attempt belongs to its turn", () => {
    it("starts the head once when its predecessor's Stop watchdog fires during app setup", async () => {
      vi.useFakeTimers();
      await send("A");
      await send("B");
      engine.cancelTurn.mockResolvedValueOnce({ outcome: "unconfirmed", turnId: "A" });
      await expect(stop()).resolves.toEqual({ unconfirmed: true });
      end("A", "cancelled");

      const releaseApps = holdAppSetup();
      engine.startTurn.mockResolvedValue(undefined);
      const firstResume = run(api.resumeQueuedMessages, { sessionId });
      expect(agent.liveTurnId(sessionId)).toBeUndefined();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await run(api.session, { sessionId })).toMatchObject({ status: "working" });
      expect((await queue()).paused).toBeNull();
      releaseApps();
      await firstResume;
      expect(starts()).toEqual(["A", "B"]);
      expect(await queue()).toMatchObject({ paused: null, items: [{ id: "B", state: "sending" }] });
      expect(await read("B")).toEqual({ content: null });
    });

    it("starts only the tail when the recovered head's complete echo arrives before Resume", async () => {
      await send("A");
      await send("B");
      await send("C");
      end("A", "cancelled");
      engine.startTurn.mockResolvedValueOnce(undefined);
      await run(api.resumeQueuedMessages, { sessionId });
      emit({ type: "turn.started", sessionId, turnId: "B", timestamp: seq });
      const echo = [...echoFrames("B", "Message B")];
      const close = echo.pop()!;
      for (const frame of echo) emit(frame);
      engine.open.mock.calls[0]![0].onEventGap!({
        sessionId,
        reason: "server_restarted",
        error: new EventGapError("lost"),
      });
      expect(await queue()).toMatchObject({
        paused: "failed",
        items: [
          { id: "B", state: "waiting" },
          { id: "C", state: "waiting" },
        ],
      });
      emit(close);
      await run(api.resumeQueuedMessages, { sessionId });
      expect(starts()).toEqual(["A", "B", "C"]);
      expect(await ids()).toEqual([]);
    });

    it("pauses on another turn's admission failure and keeps the head until its echo", async () => {
      const wire = Promise.withResolvers<void>();
      engine.startTurn.mockReturnValueOnce(wire.promise);
      const predecessor = send("A");
      await vi.waitFor(() => expect(starts()).toEqual(["A"]));
      emit({ type: "turn.started", sessionId, turnId: "A", timestamp: seq });
      await send("B");
      await send("C");
      const releaseApps = holdAppSetup();
      engine.startTurn.mockResolvedValueOnce(undefined);
      end("A");
      expect(agent.liveTurnId(sessionId)).toBeUndefined();
      wire.reject(new Error("A lost its admission reply"));
      await expect(predecessor).rejects.toThrow("A lost its admission reply");
      const duringSetup = await queue();
      releaseApps();
      await vi.waitFor(() => expect(starts()).toEqual(["A", "B"]));
      emit({ type: "turn.started", sessionId, turnId: "B", timestamp: seq });
      echo("B");
      expect(duringSetup).toMatchObject({
        paused: "failed",
        items: [
          { id: "B", state: "sending" },
          { id: "C", state: "waiting" },
        ],
      });
      expect(await queue()).toMatchObject({ paused: "failed", items: [{ id: "C" }] });
    });
  });

  it.each(["before", "after"] as const)(
    "returns the sending head ahead of unread steers when a gap lands %s admission",
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
      engine.open.mock.calls[0]![0].onEventGap!({
        sessionId,
        reason: "server_restarted",
        error: new EventGapError("lost"),
      });
      const recovered = {
        paused: "failed",
        items: [
          { id: "head", state: "waiting" },
          { text: "Message a", state: "waiting" },
          { id: "waiting", state: "waiting" },
        ],
      };
      expect(await queue()).toMatchObject(recovered);
      if (when === "before") {
        admit();
        await resuming;
      }
      expect(starts()).toEqual(["first", "head"]);
      expect(await queue()).toMatchObject(recovered);
      // The engine can replay the terminal after the gap gave up live ownership.
      expect(agent.liveTurnId(sessionId)).toBeUndefined();
      end("head", "cancelled");
      expect(await queue()).toMatchObject(recovered);
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

  it.each(["replay gap", "cancel watchdog", "confirmed cancel"] as const)(
    "withdraws a question when a %s settles its turn without a terminal event",
    async (settlement) => {
      await send("first");
      question("first");
      const [card] = pendingFor(sessionId);
      expect(card?.method).toBe("askUserQuestion");
      if (settlement === "replay gap") {
        engine.open.mock.calls[0]![0].onEventGap!({
          sessionId,
          reason: "server_restarted",
          error: new EventGapError("lost"),
        });
      } else if (settlement === "cancel watchdog") {
        vi.useFakeTimers();
        engine.cancelTurn.mockResolvedValueOnce({ outcome: "unconfirmed", turnId: "first" });
        await stop();
        expect(pendingFor(sessionId)).toEqual([card]);
        await agent.shutdown();
        await vi.advanceTimersByTimeAsync(15_000);
      } else {
        vi.useFakeTimers();
        engine.cancelTurn.mockResolvedValueOnce({ outcome: "cancelled", turnId: "first" });
        await stop();
        await vi.advanceTimersByTimeAsync(15_000);
      }
      expect(pendingFor(sessionId)).toEqual([]);
      expect(answer(card!.requestId, { result: {} })).toBe(false);
    }
  );

  it("allows a tool approval and cancels cards from a turn the handler does not hold", async () => {
    await send("current");
    emit({
      type: "permission.requested",
      sessionId,
      turnId: "old",
      requestId: "tool",
      title: "Run this tool?",
      options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
      timestamp: seq,
    });
    plan("old");
    question("old");
    expect(pendingFor(sessionId)).toEqual([]);
    await vi.waitFor(() => {
      expect(engine.respondPermission).toHaveBeenCalledWith(sessionId, "tool", {
        outcome: "selected",
        optionId: "allow",
      });
      expect(engine.respondPermission).toHaveBeenCalledWith(sessionId, "plan", {
        outcome: "cancelled",
      });
      expect(engine.respondElicitation).toHaveBeenCalledWith(sessionId, "question", {
        action: "cancel",
      });
    });
    expect(await run(api.session, { sessionId })).toMatchObject({ status: "working" });
  });

  it("settling a superseded turn's question leaves the new turn's plan waiting", async () => {
    await send("A");
    question("A");
    // A native admission replaces the handler's stale claim on A before A's end arrives.
    await agent.startTurn(sessionId, "B", "codex-app-server", "new turn", { cwd: "/tmp/repo" });
    plan("B");
    agent.notifyTurnInterrupted(sessionId, "A", true);
    await vi.waitFor(() => expect(engine.respondElicitation).toHaveBeenCalled());
    expect(pendingFor(sessionId)).toMatchObject([{ method: "exitPlanMode" }]);
    expect(await run(api.session, { sessionId })).toMatchObject({ status: "needs_plan_response" });
    end("B");
  });

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
      question("first");
      const [card] = pendingFor(sessionId);
      expect(card?.method).toBe("askUserQuestion");
      await expect(send("next")).resolves.toEqual({ turnId: "next", queued: true });
      engine.startTurn.mockImplementationOnce(async ({ turnId }) => {
        emit({ type: "turn.started", sessionId, turnId, timestamp: seq });
        plan(turnId);
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
        data: { type: "cancel", sessionId, requestId: card!.requestId },
      });
      if (reason === "cancelled") await run(api.resumeQueuedMessages, { sessionId });
      await vi.waitFor(() =>
        expect(pendingFor(sessionId)).toMatchObject([{ method: "exitPlanMode" }])
      );
      expect(engine.respondElicitation).toHaveBeenCalledWith(sessionId, "question", {
        action: "cancel",
      });
      const open = pendingFor(sessionId);
      const beforeReplay = frames.length;
      end("first", reason);
      expect(answer(card!.requestId, { result: { answers: ["main"] } })).toBe(false);
      expect(pendingFor(sessionId)).toEqual(open);
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
      if (failure === "failed") {
        await run(api.resumeQueuedMessages, { sessionId });
        const retry = engine.startTurn.mock.lastCall![0];
        expect(starts()).toEqual(["first", "a", retry.turnId]);
        expect(retry.turnId).not.toBe("a");
        expect(retry.input).toBe("Message a");
      } else {
        await agent.startTurn(sessionId, "other", "codex-app-server", "winning turn", {
          cwd: "/tmp/repo",
        });
        end("other");
        await vi.waitFor(() => expect(starts()).toEqual(["first", "a", "other", "a"]));
      }
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
    db.prepare("INSERT INTO turns (session_id, turn_id) VALUES (?, 'first')").run(sessionId);
    const busy = "The agent is still working — wait for the current turn to finish.";
    await expect(run(api.sendMessage, message("cloud"))).rejects.toThrow(busy);
    await expect(run(api.steerMessage, { ...message("cloud"), turnId: "first" })).rejects.toThrow(
      busy
    );
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
    engine.startTurn.mockImplementationOnce(async ({ turnId }) => {
      emit({ type: "turn.started", sessionId, turnId, timestamp: seq });
    });
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
      expect(sending).toBeGreaterThan(ended);
    }
    for (const state of ["sending", "steering"] as const) {
      const text = state === "sending" ? "Message next" : "Message follow-up";
      if (state === "steering") {
        first.length = 0;
        second.length = 0;
        await steer("follow-up");
      }
      const steerId = state === "steering" ? lastSteerId() : undefined;
      for (const event of echoFrames("next", text, steerId)) {
        emit(event);
        for (const frames of [first, second]) {
          const snapshot = frames.filter((f) => f.id === "queuedMessages").at(-1)!;
          const published = frames.filter((f) => f.data?.envelope).at(-1)!;
          expect(published.data?.envelope?.event).toEqual(event);
          if (event.type === "message.ended") {
            expect(snapshot.data?.items).toEqual([]);
            const cleared = frames.findIndex((f) => f.data?.items?.length === 0);
            expect(cleared).toBeGreaterThan(frames.indexOf(published));
          } else {
            expect(snapshot.data?.items).toMatchObject([{ text, state }]);
          }
        }
      }
    }
    expect(unrelated).toEqual([]);
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
