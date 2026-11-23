import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventGapError, WireRequestError } from "@zvada/agent-server/client";
import {
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
import { LOCAL_CALLER, Registry } from "../../../src/api/registry";
import { handleFrame, invalidate, serveOperations } from "../../../src/services/query-engine";
import { addConnection, closeAll } from "../../../src/services/ws.service";
import { createDeusHost } from "../../../src/services/assistants/host";
import { operations } from "../../helpers";

const engine = vi.hoisted(() => ({
  open: vi.fn<(options: AgentLinkOptions) => unknown>(),
  startTurn: vi.fn<(params: TurnStartParams & { turnId: string }) => Promise<void>>(),
  steerTurn: vi.fn<(params: TurnSteerParams) => Promise<TurnSteerResult>>(),
  cancelTurn: vi.fn<() => Promise<TurnCancelResult>>(),
  images: true,
}));

vi.mock("../../../src/services/agent/client", () => ({ AgentLink: { open: engine.open } }));
vi.mock("../../../src/lib/database", () => ({ getDatabase: () => db, DB_PATH: ":memory:" }));
vi.mock("../../../src/services/integrations", () => ({
  resolveTurnApps: () => ({ servers: {}, skipped: [] }),
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
const message = (id: string) => ({
  sessionId,
  turnId: id,
  content: `Message ${id}`,
  agentHarness: "codex-app-server" as const,
  model: `model-${id}`,
});
const send = (id: string) => run(api.sendMessage, message(id));
const queue = () => run(api.queuedMessages, { sessionId });
const starts = () => engine.startTurn.mock.calls.map(([p]) => p.turnId);
const ids = async () => (await queue()).items.map((item) => item.id);
const steer = (id: string) => run(api.steerMessage, message(id));
const steerRow = (id: string) => run(api.steerQueuedMessage, { sessionId, id });
const remove = (id: string) => run(api.removeQueuedMessage, { sessionId, id });
const stop = () => run(api.stopSession, { sessionId });
function echo(turnId: string, id: string) {
  emit({
    type: "message.started",
    sessionId,
    turnId,
    messageId: steerMessageId(id),
    outputIndex: 2,
    role: "user",
    timestamp: seq,
  });
}

beforeEach(async () => {
  db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  db.exec(`
    INSERT INTO repositories (id, name, root_path) VALUES ('r', 'repo', '/tmp/repo');
    INSERT INTO workspaces (id, repository_id, slug) VALUES ('w', 'r', 'checkout');
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
      onAuthUpdated: () => () => {},
      onCliProgress: () => () => {},
    },
    getAgents: () => [{ type: "codex-app-server", capabilities: { images: engine.images } }],
    isConnected: () => true,
    close: () => {},
  });
  engine.startTurn.mockImplementation(async ({ turnId }) => {
    emit({ type: "turn.started", sessionId, turnId, timestamp: seq });
  });
  engine.steerTurn.mockImplementation(async ({ steerId }) => ({
    outcome: "steered",
    steerId: steerId!,
  }));
  await agent.init();
});

afterEach(async () => {
  vi.useRealTimers();
  await agent.shutdown();
  closeAll();
  db.exec("DELETE FROM sessions");
  invalidate(["sessions"]);
  db.close();
  vi.clearAllMocks();
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
        content: JSON.stringify(parts),
        permissionMode: "plan",
        thinkingLevel: "high",
      })
    ).resolves.toEqual({ turnId: "second", queued: true });
    await send("third");
    expect(await queue()).toEqual({
      paused: null,
      items: [
        { id: "second", text: "Use this picture", images: 1, steering: false },
        { id: "third", text: "Message third", images: 0, steering: false },
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
      expect((await queue()).items).toMatchObject([
        { id: "steer", steering: true },
        { id: "waiting", steering: false },
      ]);
      end("first", reason, ["steer"]);
      reply.resolve({ outcome: "steered", steerId: "steer" });
      await receipt;
      if (reason === "cancelled") {
        expect(starts()).toEqual(["first"]);
        expect(await queue()).toMatchObject({
          paused: "stopped",
          items: [{ id: "steer", steering: false }, { id: "waiting" }],
        });
      } else {
        await vi.waitFor(() => expect(starts()).toEqual(["first", "steer"]));
        expect(await ids()).toEqual(["waiting"]);
      }
    }
  );

  it("the queued turn's end can start its successor before its own quick ack returns", async () => {
    await send("first");
    await send("a");
    await send("b");
    engine.startTurn.mockImplementationOnce(async ({ turnId }) => {
      emit({ type: "turn.started", sessionId, turnId, timestamp: seq });
      end(turnId);
    });
    end("first");
    await vi.waitFor(() => expect(starts()).toEqual(["first", "a", "b"]));
    expect(await ids()).toEqual([]);
    expect(agent.liveTurnId(sessionId)).toBe("b");
  });

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

  it("pauses after a failed turn, and keeps unread steers at the front in request order", async () => {
    await send("first");
    await send("waiting");
    await steer("a");
    await steer("b");
    end("first", "error", ["a", "b"]);
    expect(await queue()).toMatchObject({
      paused: "failed",
      items: [{ id: "a", steering: false }, { id: "b", steering: false }, { id: "waiting" }],
    });
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
      expect((await queue()).paused).toBe(kind === "unconfirmed" ? "stopped" : null);
      await agent.shutdown();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await queue()).toMatchObject({
        paused: kind === "unconfirmed" ? "stopped" : "failed",
        items: [{ id: "a", steering: false }, { id: "waiting" }],
      });
      expect(starts()).toEqual(["first"]);
    }
  );

  it("recovers unread steers and pauses when a gap loses the live turn", async () => {
    await send("first");
    await send("waiting");
    await steer("a");
    engine.open.mock.calls[0]![0].onEventGap!({
      sessionId,
      reason: "server_restarted",
      error: new EventGapError("lost"),
    });
    expect(starts()).toEqual(["first"]);
    expect(await queue()).toMatchObject({
      paused: "failed",
      items: [{ id: "a", steering: false }, { id: "waiting" }],
    });
  });

  it.each([true, false])(
    "steers a queued row using the running harness's images capability (%s)",
    async (images) => {
      engine.images = images;
      await send("first");
      await send("waiting");
      const picture = { type: "image", mimeType: "image/png", data: "cGljdHVyZQ==" };
      await run(api.sendMessage, {
        ...message("picture"),
        agentHarness: "claude-code",
        content: JSON.stringify([picture]),
      });
      await expect(steerRow("picture")).resolves.toEqual({ outcome: "steered" });
      expect(engine.steerTurn).toHaveBeenCalledWith({
        sessionId,
        turnId: "first",
        steerId: "picture",
        input: images ? [picture] : [{ type: "text", text: expect.stringContaining("omitted") }],
      });
      expect(await ids()).toEqual(["picture", "waiting"]);
      expect(await remove("picture")).toEqual({ content: null });
      echo("first", "unrelated");
      expect(await ids()).toEqual(["picture", "waiting"]);
      echo("first", "picture");
      expect(await ids()).toEqual(["waiting"]);
      expect((await run(api.messages, { sessionId })).messages).toContainEqual(
        expect.objectContaining({
          id: steerMessageId("picture"),
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
    echo("first", "a");
    reply.reject(new Error("connection closed"));
    await expect(receipt).resolves.toEqual({ outcome: "steered" });
    await expect(steer("a")).resolves.toEqual({ outcome: "steered" });
    expect(engine.steerTurn).toHaveBeenCalledOnce();
    end("first");
    expect(await ids()).toEqual([]);
    expect(starts()).toEqual(["first"]);
  });

  it("returns the full original content on removal, once", async () => {
    await send("first");
    const content = JSON.stringify([
      { type: "image", mimeType: "image/png", data: "cGljdHVyZQ==" },
    ]);
    const queued = await run(api.sendMessage, { ...message("image"), turnId: undefined, content });
    expect(await remove(queued.turnId)).toEqual({ content });
    expect(await remove(queued.turnId)).toEqual({ content: null });
    expect(await steerRow(queued.turnId)).toEqual({ outcome: "gone" });
    end("first");
    expect(starts()).toEqual(["first"]);
  });

  it.each(["no_active_turn", "unsupported", "threw"] as const)(
    "moves a steer the engine refused to the head (%s)",
    async (outcome) => {
      await send("first");
      await send("waiting");
      if (outcome === "threw") engine.steerTurn.mockRejectedValue(new Error("engine unavailable"));
      else engine.steerTurn.mockResolvedValue({ outcome });
      await expect(steer("a")).resolves.toEqual({ outcome: "queued" });
      expect(await ids()).toEqual(["a", "waiting"]);
      end("first");
      await vi.waitFor(() => expect(starts()).toEqual(["first", "a"]));
    }
  );

  it("sends a steer as its own turn if the working chat has just gone idle", async () => {
    await send("first");
    end("first");
    await expect(steer("a")).resolves.toEqual({ outcome: "sent" });
    expect(engine.steerTurn).not.toHaveBeenCalled();
    expect(starts()).toEqual(["first", "a"]);
  });

  it("a no_active_turn reply arriving after the end cannot enqueue a steer twice", async () => {
    await send("first");
    await send("waiting");
    const reply = Promise.withResolvers<TurnSteerResult>();
    engine.steerTurn.mockReturnValueOnce(reply.promise);
    const receipt = steer("a");
    end("first");
    reply.resolve({ outcome: "no_active_turn" });
    await receipt;
    await vi.waitFor(() => expect(starts()).toEqual(["first", "a"]));
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
      expect(await ids()).toEqual(["a", "b", "c"]);
    }
  );

  it("deduplicates a queued id, including two writes before either answer", async () => {
    await send("first");
    expect(await Promise.all([send("again"), send("again")])).toEqual([
      { turnId: "again", queued: true },
      { turnId: "again", queued: true },
    ]);
    expect(await ids()).toEqual(["again"]);
    end("first");
    await vi.waitFor(() => expect(starts()).toEqual(["first", "again"]));
    expect(await ids()).toEqual([]);
  });

  it("queues a strict send that loses the engine's admission race", async () => {
    engine.startTurn.mockRejectedValueOnce(
      new WireRequestError(WIRE_ERROR_CODES.turnActive, "busy")
    );
    await expect(send("loser")).resolves.toEqual({ turnId: "loser", queued: true });
    expect(await ids()).toEqual(["loser"]);
    emit({ type: "turn.started", sessionId, turnId: "winner", timestamp: seq });
    end("winner");
    await vi.waitFor(() => expect(starts()).toEqual(["loser", "loser"]));
  });

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
          items: [{ id: "a" }, { id: "b" }],
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
    const connect = () => {
      const frames: {
        id: string;
        data?: { status?: string; items?: unknown[]; envelope?: { event: { type: string } } };
      }[] = [];
      const id = addConnection(
        { close() {}, send: (frame) => frames.push(JSON.parse(String(frame))) },
        null
      );
      for (const resource of ["queuedMessages", "sessionEvents", "session"]) {
        handleFrame(id, { type: "q:subscribe", id: resource, resource, params: { sessionId } });
      }
      return frames;
    };
    const first = connect();
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
    for (const frames of [first, second]) {
      const ended = frames.findIndex((f) => f.data?.envelope?.event.type === "turn.ended");
      expect(ended).toBeGreaterThanOrEqual(0);
      expect(
        frames.findIndex((f) => f.id === "session" && f.data?.status === "working")
      ).toBeGreaterThan(ended);
      expect(frames.filter((f) => f.id === "queuedMessages").at(-1)?.data?.items).toEqual([]);
    }
  });
});
