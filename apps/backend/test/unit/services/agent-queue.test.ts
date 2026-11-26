import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventGapError, WireRequestError } from "@zvada/agent-server/client";
import { createOperator } from "@zvada/agent-server/operator";
import {
  createSteerEchoParts,
  createUserEchoParts,
  emptyConversation,
  echoMessageId,
  reduceConversationWithChanges,
  steerMessageId,
  WIRE_ERROR_CODES,
  type TurnCancelResult,
  type LifecycleEvent,
  type Origin,
  type SessionLimitsEvent,
  type TurnEndedEvent,
  type TurnStartParams,
  type TurnSteerParams,
  type TurnSteerResult,
} from "@zvada/agent-server/protocol";
import * as api from "@shared/api/sessions";
import { findConversationMessage } from "@shared/conversation-rows";
import { SCHEMA_SQL } from "@shared/schema";
import * as chatTurns from "../../../src/services/agent/chat-turn";
import * as agent from "../../../src/services/agent/service";
import * as cloud from "../../../src/services/agent/cloud/driver";
import {
  QueueLimitError,
  enqueueMessage,
  queuedMessages,
  resumeQueuedMessages,
  steerMessage,
  steerQueuedMessage,
} from "../../../src/services/agent/queue";
import { sendMessage, stopSession } from "../../../src/services/agent/turns";
import type { AgentLinkOptions } from "../../../src/services/agent/client";
import sessionHandlers from "../../../src/api/sessions";
import { handle, LOCAL_CALLER, Registry } from "../../../src/api/registry";
import {
  handleFrame,
  invalidate,
  onInvalidate,
  serveOperations,
} from "../../../src/services/query-engine";
import { subscribe } from "../../../src/services/streams";
import { addConnection, closeAll } from "../../../src/services/ws.service";
import { createDeusHost, queueView } from "../../../src/services/assistants/host";
import * as workspaceInit from "../../../src/services/workspace-init.service";
import { answerMcp, withSessionTools } from "../../../src/services/assistants/operator";
import * as access from "../../../src/services/assistants/access";
import * as settings from "../../../src/services/settings.service";
import * as toolRelay from "../../../src/services/agent/tool-relay";
import { resolveTurnApps } from "../../../src/services/integrations";
import { assistantCaller, operations } from "../../helpers";

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

const { answer, clearAll, pendingFor } = toolRelay;
const { reportInterruption, holdingTurn, lastTurn } = chatTurns;
const run = operations(sessionHandlers);
let db: Database.Database;
let sessionId: string;
let seq: number;
function emit(event: LifecycleEvent) {
  engine.open.mock.calls[0]![0].onEnvelope({ sessionId, seq: ++seq, event });
}
function gap(reason: "replay_failed" | "server_restarted") {
  engine.open.mock.calls[0]![0].onEventGap!({
    sessionId,
    reason,
    error: new EventGapError("lost"),
  });
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
async function sendInOrder(...ids: string[]) {
  for (const id of ids) await send(id);
}
const fromPerson = { kind: "person" } as const;
const fromChat = { kind: "session", sessionId: "lead", name: "Lead" } as const;
const fromAssistant = { kind: "assistant", id: "reviewer", name: "Reviewer" } as const;
const windowCaller = {
  kind: "external",
  id: "window",
  speaksAs: "person",
  auth: LOCAL_CALLER,
} as const;
const chatCaller = {
  kind: "session",
  sessionId: "lead",
  turnId: "task",
  harness: "codex-app-server",
  permissionMode: "bypass_permissions",
} as const;
const waitingRow = (id: string) => ({ id, state: "waiting" });
const queue = () => run(api.queuedMessages, { sessionId });
const starts = () => engine.startTurn.mock.calls.map(([p]) => p.turnId);
const lastSteerId = () => engine.steerTurn.mock.lastCall![0].steerId!;
const ids = async () => (await queue()).items.map((item) => item.id);
const wireTurnId = () => {
  const turn = holdingTurn(sessionId);
  return turn?.phase === "preparing" ? undefined : turn?.turnId;
};
const steer = (label: string) => run(api.steerMessage, { ...message(label), turnId: wireTurnId() });
const steerRow = (id: string) =>
  run(api.steerQueuedMessage, { sessionId, id, turnId: wireTurnId() });
const move = (id: string, before: string | null) =>
  run(api.moveQueuedMessage, { sessionId, id, before });
const read = (id: string) => run(api.queuedMessage, { sessionId, id });
const remove = (id: string) => run(api.removeQueuedMessage, { sessionId, id });
const resumeInWindow = () => run(api.resumeQueuedMessages, { sessionId });
const stop = () => run(api.stopSession, { sessionId });
function callQueueMcp(caller: typeof LOCAL_CALLER, name: string, args: Record<string, unknown>) {
  return answerMcp(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: { session: sessionId, ...args } },
    },
    caller
  );
}
function stopped(turnId: string, by?: Origin) {
  engine.cancelTurn.mockResolvedValueOnce({ outcome: "cancelled", turnId });
  return by ? stopSession({ sessionId }, by) : stop();
}
async function outliveStop(turnId: string) {
  vi.useFakeTimers();
  await stopped(turnId);
  await vi.advanceTimersByTimeAsync(15_000);
  vi.useRealTimers();
}

async function queueTool(
  action: "read_queue" | "send_now" | "remove" | "resume",
  id?: string,
  caller: string = fromChat.sessionId,
  mode: "plan" | "bypass_permissions" = "bypass_permissions"
) {
  const tools = withSessionTools({ name: "deus", tools: [], call: vi.fn() });
  const result = await tools.call(
    action === "read_queue" ? action : "manage_queue",
    action === "read_queue" ? { session: sessionId } : { session: sessionId, action, message: id },
    { sessionId: caller, turnId: "sender-turn", harness: "claude-code", permissionMode: mode },
    new AbortController().signal
  );
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}
async function loseStartReply(started = true) {
  const wire = pendingStart();
  const lost = expect(send("A")).rejects.toThrow("A lost its start reply");
  await vi.waitFor(() => expect(starts()).toEqual(["A"]));
  if (started) emit({ type: "turn.started", sessionId, turnId: "A", timestamp: seq });
  await send("R");
  wire.reject(new Error("A lost its start reply"));
  await lost;
}

async function failLiveReplay() {
  await sendInOrder("A", "R");
  engine.cancelTurn.mockResolvedValueOnce({ outcome: "no_active_turn", activeTurnId: "other" });
  gap("replay_failed");
  await vi.waitFor(async () => expect((await queue()).paused).toBe("failed"));
}

function holdAppSetup() {
  const apps = Promise.withResolvers<Awaited<ReturnType<typeof resolveTurnApps>>>();
  vi.mocked(resolveTurnApps).mockReturnValueOnce(apps.promise);
  return () => apps.resolve({ servers: {}, skipped: [] });
}

function busyReply(turnId?: string) {
  return new WireRequestError(WIRE_ERROR_CODES.turnActive, "busy", turnId ? { turnId } : undefined);
}
function pendingStart() {
  const reply = Promise.withResolvers<void>();
  engine.startTurn.mockReturnValueOnce(reply.promise);
  return reply;
}
function pendingSteer() {
  const reply = Promise.withResolvers<TurnSteerResult>();
  engine.steerTurn.mockReturnValueOnce(reply.promise);
  return reply;
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
  steerId?: string,
  origin?: Origin,
  messageId = steerId === undefined ? echoMessageId(turnId) : steerMessageId(steerId)
): Generator<LifecycleEvent> {
  const stamp = { sessionId, turnId, messageId, timestamp: seq };
  const outputIndex = steerId === undefined ? 0 : 2;
  yield {
    type: "message.started",
    ...stamp,
    outputIndex,
    role: "user",
    steerId,
    ...(origin && { origin }),
  };
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
  input: TurnStartParams["input"] = message(turnId).content,
  origin?: Origin
) {
  for (const frame of echoFrames(turnId, input, steerId, origin)) emit(frame);
}

function reply(turnId: string, text: string, state: "streaming" | "done" = "done") {
  const messageId = `reply-${turnId}`;
  const stamp = { sessionId, turnId, messageId, outputIndex: 1, timestamp: seq };
  emit({ type: "message.started", ...stamp, role: "assistant" });
  const part = { type: "text", id: `part-${turnId}`, sessionId, messageId, text, state } as const;
  emit({ type: "message.part", ...stamp, partIndex: 0, part });
  if (state === "done") emit({ type: "message.ended", ...stamp });
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
  engine.startTurn.mockImplementation(async ({ turnId, input, origin }) => {
    emit({ type: "turn.started", sessionId, turnId, timestamp: seq });
    echo(turnId, undefined, input, origin);
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

describe("stopping the current turn", () => {
  const host = createDeusHost();
  const operator = createOperator(host);
  const stopFromChat = () => operator.call("stop_sessions", { sessions: [sessionId] }, chatCaller);
  const view = () => host.view(chatCaller, sessionId, { last: 1 });
  const fact = (id: string) => host.turn(chatCaller, sessionId, id);

  it("O1: a chat stops setup by name and leaves a waiting row held until removed", async () => {
    db.exec("INSERT INTO sessions (id, workspace_id) VALUES ('lead', 'w')");
    const by = { kind: "session", sessionId: "lead", name: "checkout:2" };
    const frames: { type: string }[] = [];
    const window = addConnection(
      { close() {}, send: (frame) => frames.push(JSON.parse(String(frame))) },
      null
    );
    subscribe(window, "transcript", api.sessionEvents, { sessionId });
    const release = holdAppSetup();
    const starting = send("A").catch((error: unknown) => error);
    await send("later");
    const duringSetup = await view();
    const result = await stopFromChat();
    release();
    expect(await starting).toMatchObject({ message: "Stopped before it started." });
    expect(duringSetup).toMatchObject({ running: "A", status: "working" });
    expect(result).toContain('"checkout:1": stopped');
    expect(await operator.call("list_sessions", {}, chatCaller)).toMatch(/checkout:1\s+stopped/);
    expect(await operator.call("read_session", { session: sessionId }, chatCaller)).toContain(
      "(status: stopped)"
    );
    expect(await view()).toMatchObject({
      status: "stopped",
      lastEnded: { turnId: "A", outcome: "cancelled", cancelledBy: by, steers: {} },
    });
    expect(await fact("A")).toMatchObject({
      state: "ended",
      outcome: "cancelled",
      cancelledBy: by,
    });
    expect(await run(api.messages, { sessionId })).toMatchObject({ messages: [], turns: [] });
    expect(frames.map((frame) => frame.type)).toEqual(["q:subscribed"]);
    expect(await queue()).toMatchObject({
      paused: "stopped",
      stoppedBy: by,
      items: [waitingRow("later")],
    });
    await remove("later");
    expect(await queue()).toEqual({ paused: null, items: [] });
    expect(starts()).toEqual([]);
    expect(engine.cancelTurn).not.toHaveBeenCalled();
  });

  it("list_sessions names the assistant that stopped the last turn", async () => {
    await send("A");
    await stopped("A", fromAssistant);
    end("A", "cancelled");

    expect(await operator.call("list_sessions", {}, windowCaller)).toMatch(
      /checkout:1\s+stopped by assistant "Reviewer"/
    );
  });

  it("list_sessions names the later turn's stopper when both ends have the same timestamp", async () => {
    db.exec("INSERT INTO sessions (id, workspace_id) VALUES ('lead', 'w')");
    const timestamp = Date.now();
    for (const [turnId, by] of [
      ["A", fromAssistant],
      ["B", fromPerson],
    ] as const) {
      await send(turnId);
      await stopped(turnId, by);
      emit({ type: "turn.ended", sessionId, turnId, stopReason: "cancelled", timestamp });
    }

    expect(await fact("B")).toMatchObject({ outcome: "cancelled", cancelledBy: fromPerson });
    expect(await operator.call("list_sessions", {}, chatCaller)).toMatch(
      /checkout:1\s+stopped by the person/
    );
  });

  it("list_sessions names the chat that stopped app setup after an earlier Stop", async () => {
    db.exec("INSERT INTO sessions (id, workspace_id) VALUES ('lead', 'w')");
    await send("previous");
    await stopped("previous", fromPerson);
    end("previous", "cancelled");

    const release = holdAppSetup();
    const starting = expect(send("A")).rejects.toThrow("Stopped before it started.");
    await stopFromChat();
    release();
    await starting;

    expect(await operator.call("list_sessions", {}, windowCaller)).toMatch(
      /checkout:1\s+stopped by "checkout:2"/
    );
  });

  it("read_session names the chat that stopped setup after the previous turn and advances the cursor", async () => {
    db.exec("INSERT INTO sessions (id, workspace_id) VALUES ('lead', 'w'), ('reader', 'w')");
    const reader = { ...chatCaller, sessionId: "reader" };
    const read = (after?: string) =>
      operator.call("read_session", { session: sessionId, after }, reader);
    const cursor = (text: string) => JSON.parse(text.match(/^cursor: (.+)$/m)![1]!) as string;
    await send("previous");
    reply("previous", "Fixed the test.");
    end("previous");
    const before = cursor(await read());

    const release = holdAppSetup();
    const starting = expect(send("A")).rejects.toThrow("Stopped before it started.");
    await stopFromChat();
    release();
    await starting;

    const credit = '— turn cancelled by "checkout:2"';
    expect(await read()).toContain(`— turn done\n${credit}`);
    expect(await operator.call("read_session", { session: sessionId }, chatCaller)).toContain(
      "— turn cancelled by you"
    );
    const next = await read(before);
    expect(next).toContain(credit);
    expect(next).not.toContain("— turn done");
    const after = await read(cursor(next));
    expect(after).toContain("(status: stopped)");
    expect(after).not.toContain("— turn cancelled");
  });

  it("offers to wait on the chat still in app setup when the other chat has settled", async () => {
    db.exec("INSERT INTO sessions (id, workspace_id) VALUES ('settled', 'w')");
    const release = holdAppSetup();
    const starting = send("A");
    try {
      const waited = await operator.call(
        "wait_for_sessions",
        { sessions: ["checkout:2", "checkout:1"], wait: 2 },
        windowCaller
      );
      expect(waited).toContain("1 of 2 settled (until: any)");
      expect(waited.split("\n").slice(-2)).toEqual([
        '- "checkout:1": working',
        '  -> wait_for_sessions(sessions: ["checkout:1"])',
      ]);
    } finally {
      release();
      await starting;
    }
  });

  it("a wait wakes stopped and reads the credited setup end after an earlier reply", async () => {
    await send("previous");
    reply("previous", "Fixed the test.");
    end("previous");
    holdAppSetup();
    const starting = expect(send("A")).rejects.toThrow("Stopped before it started.");
    const watching = Promise.withResolvers<void>();
    const waiter = createOperator({
      ...host,
      async view(...args) {
        const reading = await host.view(...args);
        if (reading.running === "A") watching.resolve();
        return reading;
      },
    });
    const waiting = waiter.call(
      "wait_for_sessions",
      { sessions: [sessionId], wait: 5 },
      chatCaller
    );
    await watching.promise;
    await stop();
    await starting;
    expect(await view()).toMatchObject({
      status: "stopped",
      lastEnded: { turnId: "A", outcome: "cancelled", cancelledBy: fromPerson },
      turns: [
        { turnId: "previous", messages: [{ parts: [{ text: "Fixed the test." }] }] },
        { turnId: "A", outcome: "cancelled", cancelledBy: fromPerson, messages: [] },
      ],
    });
    expect(await waiting).toContain("status: stopped");
  });

  it("O2: an interrupt during app setup sees the end and admits the replacement", async () => {
    const release = holdAppSetup();
    const starting = send("A").catch((error: unknown) => error);
    const result = await operator.call(
      "send_message",
      { session: sessionId, message: "Take B instead", when: "interrupt", wait: 0 },
      chatCaller
    );
    release();
    expect(result).toContain(`stopped "checkout:1"'s turn; sent to "checkout:1"`);
    expect(await starting).toMatchObject({ message: "Stopped before it started." });
    expect(engine.startTurn.mock.calls.map(([p]) => p.input)).toEqual(["Take B instead"]);
    expect(await view()).toMatchObject({ running: starts()[0], status: "working" });
  });

  it("O4: an ended turn is settled and cannot be stopped while its lost start reply is pending", async () => {
    const wire = pendingStart();
    const lost = expect(send("A")).rejects.toThrow("A lost its start reply");
    await vi.waitFor(() => expect(starts()).toEqual(["A"]));
    emit({ type: "turn.started", sessionId, turnId: "A", timestamp: seq });
    reply("A", "Finished.");
    end("A");
    try {
      expect(await fact("A")).toMatchObject({ state: "ended", outcome: "done" });
      const reading = await view();
      expect(reading.status).toBe("idle");
      expect(reading.running).toBeUndefined();
      expect(await stopFromChat()).toContain('"checkout:1": nothing was running');
    } finally {
      wire.reject(new Error("A lost its start reply"));
      await lost;
    }
    expect(engine.cancelTurn).not.toHaveBeenCalled();
    expect(await run(api.session, { sessionId })).toMatchObject({
      status: "idle",
      error_message: null,
    });
    expect(await queue()).toEqual({ paused: null, items: [] });
  });

  it("keeps the turn and its read steer through a lost start reply until its end", async () => {
    const wire = pendingStart();
    const lost = expect(send("A")).rejects.toThrow("lost reply");
    await vi.waitFor(() => expect(starts()).toEqual(["A"]));
    await steerMessage({ ...message("follow-up"), turnId: "A" }, fromChat, "follow-up");
    echo("A", "follow-up", message("follow-up").content, fromChat);
    expect((await run(api.messages, { sessionId })).turns).toEqual([]);
    wire.reject(new Error("lost reply"));
    await lost;
    expect(await fact("A")).toEqual({ state: "running", steers: { "follow-up": "read" } });
    end("A");
    expect(await fact("A")).toMatchObject({ state: "ended", steers: { "follow-up": "read" } });
  });

  it("keeps a refused start unknown and its unread steer in read_queue, then retries the send id", async () => {
    const wire = pendingStart();
    const refused = expect(send("A")).rejects.toThrow("start refused");
    await vi.waitFor(() => expect(starts()).toEqual(["A"]));
    await expect(
      steerMessage({ ...message("follow-up"), turnId: "A" }, fromChat, "follow-up")
    ).resolves.toEqual({ outcome: "steered" });
    wire.reject(new WireRequestError(WIRE_ERROR_CODES.internalError, "start refused"));
    await refused;
    expect(await fact("A")).toEqual({ state: "unknown" });
    expect(await queueTool("read_queue")).toContain('· message "follow-up"');
    expect(wireTurnId()).toBeUndefined();
    expect(lastTurn(sessionId)).toBeUndefined();
    expect(await queue()).toMatchObject({ items: [waitingRow("follow-up")] });
    expect((await run(api.messages, { sessionId })).turns).toEqual([]);
    await expect(send("A")).resolves.toEqual({ turnId: "A" });
    expect(starts()).toEqual(["A", "A"]);
  });

  it("retries the same send id after two Stops on a refused start", async () => {
    const wire = pendingStart();
    const refused = expect(send("A")).rejects.toThrow("start refused");
    await vi.waitFor(() => expect(starts()).toEqual(["A"]));
    const stops = [stop(), stop()];
    wire.reject(new Error("start refused"));
    await Promise.all([refused, ...stops]);
    const before = await run(api.messages, { sessionId });

    await expect(send("A")).resolves.toEqual({ turnId: "A" });
    expect(starts()).toEqual(["A", "A"]);
    expect(before.turns).toEqual([]);
    expect(engine.cancelTurn).not.toHaveBeenCalled();
  });

  it("O4: A's lost start reply leaves B working in app setup and stoppable", async () => {
    const wire = pendingStart();
    const lost = expect(send("A")).rejects.toThrow("late reply");
    await vi.waitFor(() => expect(starts()).toEqual(["A"]));
    emit({ type: "turn.started", sessionId, turnId: "A", timestamp: seq });
    end("A");
    const a = await run(api.messages, { sessionId });
    const release = holdAppSetup();
    const starting = send("B").catch((error: unknown) => error);
    wire.reject(new Error("late reply"));
    await lost;
    const status = await run(api.session, { sessionId });
    const before = await view();
    const result = await stopFromChat();
    release();
    expect(await starting).toMatchObject({ message: "Stopped before it started." });
    expect(status).toMatchObject({ status: "working", error_message: null });
    expect(before).toMatchObject({ status: "working", running: "B" });
    expect(result).toContain('"checkout:1": stopped');
    expect(await fact("B")).toMatchObject({ state: "ended", outcome: "cancelled" });
    expect((await run(api.messages, { sessionId })).turns).toEqual(a.turns);
    expect(starts()).toEqual(["A"]);
  });

  it.each(["transport", "wire"] as const)(
    "O5: a lost %s start reply leaves A working, refuses B and stops A by id",
    async (source) => {
      const wire = pendingStart();
      const lost = expect(send("A")).rejects.toThrow("late reply");
      await vi.waitFor(() => expect(starts()).toEqual(["A"]));
      emit({ type: "turn.started", sessionId, turnId: "A", timestamp: seq });
      wire.reject(
        source === "wire"
          ? new WireRequestError(WIRE_ERROR_CODES.internalError, "late reply")
          : new Error("late reply")
      );
      await lost;
      expect(await run(api.session, { sessionId })).toMatchObject({
        status: "working",
        error_message: null,
      });
      await expect(
        host.send(chatCaller, sessionId, { turnId: "B", message: "B", origin: fromChat })
      ).rejects.toMatchObject({ refusal: { code: "busy" } });
      expect(await view()).toMatchObject({ status: "working", running: "A" });
      engine.cancelTurn.mockImplementationOnce(async () => {
        end("A", "cancelled");
        return { outcome: "cancelled", turnId: "A" };
      });
      expect(await stopFromChat()).toContain('"checkout:1": stopped');
      expect(engine.cancelTurn.mock.calls).toEqual([[sessionId, "A"]]);
      expect(await fact("A")).toMatchObject({ state: "ended", outcome: "cancelled" });
      expect(starts()).toEqual(["A"]);
    }
  );

  it("O3: Stop on the wire waits for a lost reply, then cancels the turn whose events arrived", async () => {
    const wire = pendingStart();
    const lost = expect(send("A")).rejects.toThrow("lost ack");
    await vi.waitFor(() => expect(starts()).toEqual(["A"]));
    emit({ type: "turn.started", sessionId, turnId: "A", timestamp: seq });
    engine.cancelTurn.mockImplementationOnce(async () => {
      end("A", "cancelled");
      return { outcome: "cancelled", turnId: "A" };
    });
    const stopping = stop();
    expect(engine.cancelTurn).not.toHaveBeenCalled();
    wire.reject(new Error("lost ack"));
    await lost;
    await stopping;
    expect(engine.cancelTurn.mock.calls).toEqual([[sessionId, "A"]]);
    expect(await fact("A")).toMatchObject({ state: "ended", cancelledBy: fromPerson });
  });

  function fatalError(turnId: string) {
    emit({
      type: "error",
      sessionId,
      turnId,
      timestamp: seq,
      message: "Failed",
      category: "internal",
      recoverable: false,
    });
  }

  it("queues a person's send after a fatal error and holds it for Resume when the turn ends", async () => {
    await send("A");
    fatalError("A");
    expect(await send("B")).toEqual({ turnId: "B", queued: true });
    expect(await view()).toMatchObject({ running: "A" });
    expect(starts()).toEqual(["A"]);

    end("A", "error");
    expect(await queue()).toMatchObject({ paused: "failed", items: [waitingRow("B")] });
    expect(starts()).toEqual(["A"]);
    await resumeInWindow();
    expect(starts()).toEqual(["A", "B"]);
  });

  it("credits the operator who stops the turn that reported a fatal error and holds the queued send", async () => {
    await send("A");
    fatalError("A");
    await send("B");
    engine.cancelTurn.mockImplementationOnce(async () => {
      end("A", "cancelled");
      return { outcome: "cancelled", turnId: "A" };
    });
    expect(await stopFromChat()).toContain('"checkout:1": stopped');
    expect(engine.cancelTurn.mock.calls).toEqual([[sessionId, "A"]]);
    expect(await queue()).toMatchObject({
      paused: "stopped",
      stoppedBy: { kind: "session", sessionId: chatCaller.sessionId },
      items: [waitingRow("B")],
    });
    await remove("B");
    expect(await queue()).toEqual({ paused: null, items: [] });
    expect(starts()).toEqual(["A"]);
  });

  it("refuses strict sends until the turn that reported a fatal error ends", async () => {
    await send("A");
    fatalError("A");
    await expect(sendMessage({ ...message("C"), turnId: "C" })).rejects.toMatchObject({
      name: "ChatBusyError",
      message: "The agent is still working — wait for the current turn to finish.",
    });
    await expect(
      host.send(chatCaller, sessionId, {
        turnId: "D",
        message: "Fourth",
        origin: fromChat,
      })
    ).rejects.toMatchObject({ refusal: { code: "busy" } });
    expect((await view()).running).toBe("A");
    end("A", "error");
    await send("B");
    expect(starts()).toEqual(["A", "B"]);
  });

  it("refuses the operator before the wire and drains the resumed row when the stopped turn ends", async () => {
    await sendInOrder("A", "C");
    await stopped("A");
    expect(await queue()).toMatchObject({ paused: "stopped", items: [waitingRow("C")] });
    fatalError("A");
    await expect(
      host.send(chatCaller, sessionId, { turnId: "B", message: "Message B", origin: fromChat })
    ).rejects.toMatchObject({ refusal: { code: "busy" } });
    await resumeInWindow();
    expect(starts()).toEqual(["A"]);
    expect(await queue()).toMatchObject({ paused: null, items: [waitingRow("C")] });
    end("A", "cancelled");
    await vi.waitFor(() => expect(starts()).toEqual(["A", "C"]));
    expect(await queue()).toEqual({ paused: null, items: [] });
  });

  it("drains a waiting row when the engine end precedes a strict sender's busy answer", async () => {
    await send("A");
    await outliveStop("A");
    const wire = pendingStart();
    const refused = expect(
      host.send(chatCaller, sessionId, { turnId: "B", message: "B", origin: fromChat })
    ).rejects.toMatchObject({ refusal: { code: "busy" } });
    await vi.waitFor(() => expect(starts()).toEqual(["A", "B"]));
    await expect(send("C")).resolves.toEqual({ turnId: "C", queued: true });
    end("A");
    wire.reject(busyReply("A"));
    await refused;
    await vi.waitFor(() => expect(starts()).toEqual(["A", "B", "C"]));
    expect(await ids()).toEqual([]);
  });

  it.each(["end_turn", "error"] as const)(
    "restores the recorded %s after a strict busy refusal with no successor",
    async (stopReason) => {
      await send("A");
      await outliveStop("A");
      const wire = pendingStart();
      const busy = expect(
        sendMessage({ ...message("B"), turnId: "B" }, fromChat)
      ).rejects.toMatchObject({ name: "ChatBusyError" });
      await vi.waitFor(() => expect(starts()).toEqual(["A", "B"]));
      const error =
        stopReason === "error"
          ? ({ category: "internal", message: "A failed" } as const)
          : undefined;
      emit({ type: "turn.ended", sessionId, turnId: "A", timestamp: seq, stopReason, error });
      expect(await run(api.session, { sessionId })).toMatchObject({ status: "working" });
      wire.reject(busyReply("A"));
      await busy;
      const status = error ? "error" : "idle";
      expect(await run(api.session, { sessionId })).toMatchObject({
        status,
        error_message: error?.message ?? null,
      });
      expect(await view()).toMatchObject({ status });
      expect(lastTurn(sessionId)?.turnId).toBe("A");
      expect(holdingTurn(sessionId)).toBeUndefined();
    }
  );

  it("restores A's standalone sign-in error after its generic end while B prepares", async () => {
    await send("A");
    await outliveStop("A");
    const release = holdAppSetup();
    const starting = expect(send("B")).rejects.toThrow("Stopped before it started");
    const message = "Sign in with a fresh account";
    emit({
      type: "error",
      sessionId,
      turnId: "A",
      timestamp: seq,
      category: "auth",
      message,
      recoverable: false,
    });
    emit({
      type: "turn.ended",
      sessionId,
      turnId: "A",
      timestamp: seq,
      stopReason: "error",
      error: { category: "internal", message: "Agent process exited" },
    });
    expect(await run(api.session, { sessionId })).toMatchObject({
      status: "working",
      error_message: null,
      error_category: null,
    });
    await stop();
    release();
    await starting;
    expect(await run(api.session, { sessionId })).toMatchObject({
      status: "error",
      error_message: message,
      error_category: "auth",
    });
  });

  it("restores A's late engine error when B stops in app setup", async () => {
    await send("A");
    await outliveStop("A");
    const release = holdAppSetup();
    const stopped = expect(send("B")).rejects.toThrow("Stopped before it started");
    emit({
      type: "turn.ended",
      sessionId,
      turnId: "A",
      timestamp: seq,
      stopReason: "error",
      error: { category: "auth", message: "Sign in to continue." },
    });
    expect(await run(api.session, { sessionId })).toMatchObject({
      status: "working",
      error_message: null,
    });
    await stop();
    release();
    await stopped;
    expect(await run(api.session, { sessionId })).toMatchObject({
      status: "error",
      error_message: "Sign in to continue.",
      error_category: "auth",
    });
    expect(await fact("B")).toMatchObject({ state: "ended", outcome: "cancelled" });
  });

  it("restores A's replay failure when its successful terminal beats B's busy answer", async () => {
    await send("A");
    engine.cancelTurn.mockResolvedValueOnce({ outcome: "cancelled", turnId: "A" });
    gap("replay_failed");
    await vi.waitFor(() => expect(holdingTurn(sessionId)).toBeUndefined());
    const prior = (await run(api.session, { sessionId }))!;
    expect(prior.error_category).toBe("network");
    const wire = pendingStart();
    const refused = expect(sendMessage({ ...message("B"), turnId: "B" })).rejects.toThrow(
      /working/
    );
    await vi.waitFor(() => expect(starts()).toEqual(["A", "B"]));
    end("A");
    wire.reject(busyReply("A"));
    await refused;
    expect(await run(api.session, { sessionId })).toMatchObject({
      status: "error",
      error_category: "network",
      error_message: prior.error_message,
    });
  });

  it("retries the busy head when a pending Stop finds the engine idle after another agent's busy Resume", async () => {
    await send("A");
    await outliveStop("A");
    engine.startTurn.mockRejectedValueOnce(busyReply("A"));
    await send("B");
    expect(starts()).toEqual(["A", "B"]);
    const reply = Promise.withResolvers<TurnCancelResult>();
    engine.cancelTurn.mockReturnValueOnce(reply.promise);
    const stopping = stopSession({ sessionId }, fromAssistant);
    expect(engine.cancelTurn).toHaveBeenLastCalledWith(sessionId, undefined);
    engine.startTurn.mockRejectedValueOnce(busyReply("A"));
    await resumeQueuedMessages(sessionId, fromChat);
    expect(starts()).toEqual(["A", "B", "B"]);
    expect(await queue()).toMatchObject({ paused: "failed", items: [waitingRow("B")] });
    reply.resolve({ outcome: "no_active_turn" });
    await stopping;
    await vi.waitFor(() => expect(starts()).toEqual(["A", "B", "B", "B"]));
    expect(await queue()).toEqual({ paused: null, items: [] });
  });

  it.each(["stopped in setup", "refused on the wire"] as const)(
    "keeps the engine's busy fence when the operator's send is %s",
    async (when) => {
      await send("A");
      await outliveStop("A");
      engine.startTurn.mockRejectedValueOnce(busyReply("A"));
      await send("B");
      const setup = when === "stopped in setup";
      const release = setup ? holdAppSetup() : undefined;
      const wire = setup ? undefined : pendingStart();
      const sending = expect(
        host.send(windowCaller, sessionId, {
          message: "Message C",
          turnId: "C",
          origin: fromPerson,
        })
      ).rejects.toThrow(setup ? /Stopped before it started/ : /start refused/);
      await vi.waitFor(() =>
        expect(holdingTurn(sessionId)?.phase).toBe(setup ? "preparing" : "starting")
      );
      const stopping = stopSession({ sessionId }, fromAssistant);
      wire?.reject(new Error("start refused"));
      release?.();
      await Promise.all([sending, stopping]);
      expect(starts().filter((id) => id === "B")).toHaveLength(1);
      engine.startTurn.mockRejectedValueOnce(busyReply("A"));
      await resumeQueuedMessages(sessionId, fromChat);
      expect(await ids()).toEqual(["B"]);
      expect(starts().filter((id) => id === "B")).toHaveLength(2);
      end("A");
      await vi.waitFor(() => expect(starts().filter((id) => id === "B")).toHaveLength(3));
    }
  );

  it.each(["person", "agent"])(
    "shows Resume and retries the busy head on each %s Resume with the original send id",
    async (who) => {
      await send("A");
      await outliveStop("A");
      engine.startTurn.mockRejectedValueOnce(busyReply("A"));
      await send("B");
      expect(await queue()).toMatchObject({ paused: "failed", items: [waitingRow("B")] });
      const resume = () =>
        who === "person" ? resumeInWindow() : resumeQueuedMessages(sessionId, fromChat);
      const published: (string | null)[] = [];
      const unwatch = onInvalidate((names) => {
        if (names.includes("queuedMessages")) published.push(queuedMessages(sessionId).paused);
      });
      engine.startTurn.mockRejectedValueOnce(busyReply("A"));
      try {
        await resume();
        expect(published.at(-1)).toBe("failed");
      } finally {
        unwatch();
      }
      expect(starts()).toEqual(["A", "B", "B"]);
      expect(await ids()).toEqual(["B"]);
      await resume();
      expect(starts()).toEqual(["A", "B", "B", "B"]);
      expect(await queue()).toEqual({ paused: null, items: [] });
    }
  );

  it("keeps a later composer send behind the busy head until the named turn ends", async () => {
    await send("A");
    await outliveStop("A");
    engine.startTurn.mockRejectedValueOnce(busyReply("A"));
    await expect(send("B")).resolves.toEqual({ turnId: "B", queued: true });
    await expect(send("C")).resolves.toEqual({ turnId: "C", queued: true });
    expect(starts()).toEqual(["A", "B"]);
    expect(await ids()).toEqual(["B", "C"]);
    end("A");
    await vi.waitFor(() => expect(starts()).toEqual(["A", "B", "B"]));
    end("B");
    await vi.waitFor(() => expect(starts()).toEqual(["A", "B", "B", "C"]));
  });

  it.each(["evicted", "log_reset", "subscription_refused"] as const)(
    "keeps the turn running after a %s gap until its end reports the missed output",
    async (reason) => {
      await send("A");
      engine.open.mock.calls[0]![0].onEventGap!({
        sessionId,
        reason,
        error: new EventGapError("lost"),
      });
      expect(engine.cancelTurn).not.toHaveBeenCalled();
      expect(await fact("A")).toMatchObject({ state: "running" });
      end("A");
      expect(await run(api.session, { sessionId })).toMatchObject({
        status: "error",
        error_category: "network",
      });
    }
  );

  it.each(["before", "after"])(
    "waits for the winner named by busy when a different late end arrives %s the reply",
    async (when) => {
      await send("A");
      await outliveStop("A");
      const wire = pendingStart();
      const sending = send("B");
      await vi.waitFor(() => expect(starts()).toEqual(["A", "B"]));
      if (when === "before") end("A");
      wire.reject(busyReply("winner"));
      await sending;
      if (when === "after") end("A");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(starts()).toEqual(["A", "B"]);
      emit({ type: "turn.started", sessionId, turnId: "winner", timestamp: seq });
      end("winner");
      await vi.waitFor(() => expect(starts()).toEqual(["A", "B", "B"]));
    }
  );

  it("stores a local end before the queue can claim its next turn", async () => {
    vi.useFakeTimers();
    await sendInOrder("A", "B");
    await stopped("A");
    await resumeInWindow();
    const stored = vi.fn(() =>
      db
        .prepare("SELECT ended_at FROM turns WHERE session_id = ? AND turn_id = 'A'")
        .pluck()
        .get(sessionId)
    );
    const unwatch = onInvalidate(() => {
      if (holdingTurn(sessionId)?.turnId === "B") stored();
    });
    try {
      await vi.advanceTimersByTimeAsync(15_000);
      expect(starts()).toEqual(["A", "B"]);
      expect(stored).toHaveBeenCalled();
      expect(stored.mock.results[0]!.value).toEqual(expect.any(Number));
    } finally {
      unwatch();
    }
  });

  it("retries B on A’s late end after C was stopped in setup", async () => {
    await send("A");
    await outliveStop("A");
    const release = holdAppSetup();
    const cancelled = expect(send("C")).rejects.toThrow("Stopped before it started");
    await stop();
    release();
    await cancelled;
    engine.startTurn.mockRejectedValueOnce(busyReply("A"));
    await expect(send("B")).resolves.toEqual({ turnId: "B", queued: true });
    expect(starts()).toEqual(["A", "B"]);
    const seen: string[] = [];
    const unwatch = onInvalidate(() => {
      const status = db
        .prepare<[string], { status: string }>("SELECT status FROM sessions WHERE id = ?")
        .get(sessionId)!.status;
      seen.push(status);
    });
    try {
      end("A");
      await vi.waitFor(() => expect(starts()).toEqual(["A", "B", "B"]));
      expect(seen[0]).toBe("idle");
      expect(seen.at(-1)).toBe("working");
      expect(await queue()).toEqual({ paused: null, items: [] });
    } finally {
      unwatch();
    }
  });

  it("keeps the last pre-wire end until the next turn is released", async () => {
    let previous: string | undefined;
    for (const id of ["A", "B", "C"]) {
      holdAppSetup();
      const aborted = expect(send(id)).rejects.toThrow("Stopped before it started");
      if (previous)
        expect(await fact(previous)).toMatchObject({
          state: "ended",
          outcome: "cancelled",
          cancelledBy: fromPerson,
        });
      await stop();
      await aborted;
      expect(await fact(id)).toMatchObject({ state: "ended", cancelledBy: fromPerson });
      previous = id;
    }
    expect(await fact("A")).toEqual({ state: "unknown" });
    expect(await fact("B")).toEqual({ state: "unknown" });
    await send("D");
    expect(await fact("C")).toMatchObject({
      state: "ended",
      outcome: "cancelled",
      cancelledBy: fromPerson,
    });
    end("D");
    expect(await fact("C")).toEqual({ state: "unknown" });
  });

  it("an older setup abort settling after a new admission leaves the new send working", async () => {
    await send("previous");
    end("previous");
    const releaseA = holdAppSetup();
    const aborted = expect(send("A")).rejects.toThrow("Stopped before it started");
    const stopping = stop();
    emit({
      type: "error",
      sessionId,
      turnId: "previous",
      timestamp: seq,
      category: "internal",
      message: "Late engine error",
      recoverable: false,
    });
    const releaseB = holdAppSetup();
    const b = send("B");
    await Promise.all([aborted, stopping]);
    const session = await run(api.session, { sessionId });
    const before = await view();
    releaseA();
    releaseB();
    await b;
    expect(before).toMatchObject({ running: "B" });
    expect(session).toMatchObject({ status: "working", error_message: null });
    expect(await fact("A")).toMatchObject({ state: "ended", outcome: "cancelled" });
    expect(await queue()).toEqual({ paused: null, items: [] });
    expect(starts()).toEqual(["previous", "B"]);
  });

  async function startHeldFirstTask() {
    db.exec(`INSERT INTO workspaces (id, repository_id, slug, state, first_session_id)
      VALUES ('new', 'r', 'new', 'initializing', 'first-chat')`);
    vi.spyOn(workspaceInit, "createLocalWorkspace").mockResolvedValue({
      workspaceId: "new",
      firstSessionId: "first-chat",
    });
    const entry = await host.start!(windowCaller, {
      turnId: "first-task",
      harness: "codex-app-server",
      project: { id: "r", name: "repo" },
      message: "Build it",
      origin: fromPerson,
    });
    expect(await host.view(windowCaller, entry.id, {})).toMatchObject({ status: "setting_up" });
    sessionId = entry.id;
    const release = holdAppSetup();
    db.exec(`INSERT INTO sessions (id, workspace_id) VALUES ('first-chat', 'new');
      UPDATE workspaces SET state = 'ready', current_session_id = 'first-chat' WHERE id = 'new'`);
    invalidate(["workspaces"]);
    return { entry, release };
  }

  it("O7: a held first task becomes a named turn as soon as its workspace is ready", async () => {
    const { entry, release } = await startHeldFirstTask();
    const reading = await host.view(windowCaller, entry.id, {});
    expect(reading.running).toBe("first-task");
    expect(await host.cancel!(windowCaller, entry.id, reading.running)).toBe("stopped");
    release();
    expect(starts()).toEqual([]);
    expect(await host.turn(windowCaller, entry.id, "first-task")).toMatchObject({
      state: "ended",
      outcome: "cancelled",
      cancelledBy: fromPerson,
    });
    expect(await host.view(windowCaller, entry.id, {})).toMatchObject({
      status: "error",
      lastEnded: { turnId: "first-task", outcome: "cancelled", cancelledBy: fromPerson },
    });
  });

  it("interrupts a first task in app setup and delivers the replacement", async () => {
    const { entry, release } = await startHeldFirstTask();
    const result = await operator.call(
      "send_message",
      { session: entry.id, message: "Do this instead", when: "interrupt", wait: 0 },
      windowCaller
    );
    release();
    expect(result).toContain(`stopped "new:1"'s turn; sent to "new:1"`);
    expect(engine.startTurn.mock.calls.map(([p]) => p.input)).toEqual(["Do this instead"]);
    expect(await view()).toMatchObject({ status: "working", running: starts()[0] });
  });

  it("keeps an unnamed first-task Stop aimed at that task when a successor is already running", async () => {
    const { entry, release } = await startHeldFirstTask();
    const ack = pendingStart();
    release();
    await vi.waitFor(() => expect(starts()).toEqual(["first-task"]));
    emit({ type: "turn.started", sessionId, turnId: "first-task", timestamp: seq });
    end("first-task");
    try {
      await send("successor");
      expect(await host.cancel!(windowCaller, entry.id)).toBe("not_running");
      expect(engine.cancelTurn).not.toHaveBeenCalled();
      expect(await view()).toMatchObject({ running: "successor" });
    } finally {
      ack.resolve();
    }
  });

  it("queues the default operator steer first during a first task's app setup and honors Stop", async () => {
    const { release } = await startHeldFirstTask();
    await send("tail");
    const result = await operator.call(
      "send_message",
      { session: sessionId, message: "Check this first", wait: 0 },
      windowCaller
    );
    expect(result).toContain(
      'turn "first-task" did not take it; the product queued it as its own turn.'
    );
    expect(await queue()).toMatchObject({
      paused: null,
      items: [{ text: "Check this first", state: "waiting" }, waitingRow("tail")],
    });
    expect(engine.steerTurn).not.toHaveBeenCalled();
    await stop();
    release();
    expect(starts()).toEqual([]);
    expect(await queue()).toMatchObject({ paused: "stopped", stoppedBy: fromPerson });
    await resumeInWindow();
    expect(engine.startTurn.mock.calls.map(([p]) => p.input)).toEqual(["Check this first"]);
    end(starts()[0]!);
    await vi.waitFor(() => expect(starts().at(-1)).toBe("tail"));
  });
});

describe("messages held for a local chat", () => {
  it("starts a fresh steer on a free chat with a stale card and steers its holder with a stale idle status", async () => {
    db.prepare("UPDATE sessions SET status = 'needs_response' WHERE id = ?").run(sessionId);
    const next = await steerMessage(message("first"), fromChat, "first");
    expect(next).toEqual({ outcome: "sent" });
    db.prepare("UPDATE sessions SET status = 'idle' WHERE id = ?").run(sessionId);
    await expect(
      steerMessage({ ...message("follow-up"), turnId: "first" }, fromChat, "follow-up")
    ).resolves.toEqual({ outcome: "steered" });
    expect(starts()).toEqual(["first"]);
    expect(lastSteerId()).toBe("follow-up");
  });

  it.each(["composer", "row"] as const)(
    "holds a late %s steer for its own turn when the displayed turn has ended",
    async (source) => {
      await sendInOrder("A", "B", "tail");
      if (source === "row") await send("follow-up");
      const turnId = wireTurnId();
      const request =
        source === "row"
          ? () => run(api.steerQueuedMessage, { sessionId, id: "follow-up", turnId })
          : () => run(api.steerMessage, { ...message("follow-up"), turnId });
      end("A");
      await vi.waitFor(() => expect(wireTurnId()).toBe("B"));
      await expect(request()).resolves.toEqual({});
      expect(engine.steerTurn).not.toHaveBeenCalled();
      expect((await queue()).items).toMatchObject([
        { text: "Message follow-up", state: "waiting" },
        { id: "tail" },
      ]);
      expect(starts()).toEqual(["A", "B"]);
    }
  );

  it("puts a steer from a client without a displayed turn first in the queue", async () => {
    await sendInOrder("active", "waiting", "row");
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
      await sendInOrder("A", "B", "waiting", "row");
      end("A");
      await vi.waitFor(() => expect(wireTurnId()).toBe("B"));
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
    await vi.waitFor(() => expect(wireTurnId()).toBe("C"));
    end("C");
    await vi.waitFor(() => expect(wireTurnId()).toBe("A"));
    end("A");
    await vi.waitFor(() => expect(starts()).toEqual(["working", "C", "A", "B"]));
  });

  it("moves a waiting row to the end without resuming a paused queue", async () => {
    await sendInOrder("working", "A", "B");
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
    await vi.waitFor(() => expect(wireTurnId()).toBe("head"));
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
      await sendInOrder("first", "waiting");
      const reply = pendingSteer();
      const receipt = steerMessage({ ...message("steer"), turnId: "first" }, fromChat);
      const rows = (await queue()).items;
      expect(rows).toMatchObject([
        { text: "Message steer", state: "steering", origin: fromChat },
        waitingRow("waiting"),
      ]);
      const rowId = rows[0]!.id;
      const attempt = lastSteerId();
      expect(attempt).toBe(rowId);
      expect(engine.steerTurn.mock.lastCall![0]).toMatchObject({
        turnId: "first",
        origin: fromChat,
      });
      end("first", reason, [attempt]);
      reply.resolve({ outcome: "steered", steerId: attempt });
      await receipt;
      expect((await run(api.messages, { sessionId })).turns).toContainEqual(
        expect.objectContaining({ turnId: "first", undeliveredSteers: [attempt] })
      );
      if (reason === "cancelled") {
        expect(starts()).toEqual(["first"]);
        expect(await queue()).toMatchObject({
          paused: "stopped",
          items: [{ id: rowId, state: "waiting", origin: fromChat }, { id: "waiting" }],
        });
      } else {
        await vi.waitFor(() => expect(starts()).toEqual(["first", rowId]));
        expect(engine.startTurn.mock.lastCall![0].origin).toEqual(fromChat);
        expect(await ids()).toEqual(["waiting"]);
      }
    }
  );

  it("the queued turn's end can start its successor before its own quick ack returns", async () => {
    await sendInOrder("first", "a", "b");
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
    expect(wireTurnId()).toBe("b");
  });

  it.each(["before", "after"] as const)(
    "shows the sending head through app setup until its echo %s the admission reply",
    async (when) => {
      await sendInOrder("first", "head", "tail");
      end("first", "cancelled");
      const releaseApps = holdAppSetup();
      const admit = holdAdmission();
      const resuming = resumeInWindow();
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
      await sendInOrder("first", "head", "tail");
      end("first", "cancelled");
      const admit = holdAdmission();
      const resuming = resumeInWindow();
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
        items: [waitingRow("head"), waitingRow("tail")],
      });
      expect(await read("head")).toEqual({ content: "Message head" });
      expect(starts()).toEqual(["first", "head"]);

      engine.startTurn.mockResolvedValueOnce(undefined);
      await resumeInWindow();
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
    await sendInOrder("first", "head");
    end("first", "cancelled");
    const admit = holdAdmission();
    const resuming = resumeInWindow();
    await vi.waitFor(() => expect(starts()).toEqual(["first", "head"]));
    emit({ type: "session.ended", sessionId, reason: "idle", timestamp: seq });
    admit();
    await resuming;
    expect(await queue()).toMatchObject({
      paused: null,
      items: [{ id: "head", state: "sending" }],
    });
    reportInterruption(sessionId, undefined, true);
    reportInterruption(sessionId, "head", false);
    expect(await queue()).toMatchObject({
      paused: "failed",
      items: [{ id: "head", state: "sending" }],
    });
    end("head", "error");
    expect(await queue()).toMatchObject({
      paused: "failed",
      items: [waitingRow("head")],
    });
    expect(starts()).toEqual(["first", "head"]);
  });

  it("keeps a live head sending when its admission reply fails before its echo", async () => {
    await sendInOrder("first", "head");
    end("first", "cancelled");
    const wire = pendingStart();
    const resuming = resumeInWindow();
    await vi.waitFor(() => expect(starts()).toEqual(["first", "head"]));
    emit({ type: "turn.started", sessionId, turnId: "head", timestamp: seq });
    wire.reject(new Error("connection lost"));
    await resuming;
    expect((await queue()).paused).toBeNull();
    await resumeInWindow();
    expect(starts()).toEqual(["first", "head"]);
    expect((await queue()).items).toMatchObject([{ id: "head", state: "sending" }]);
    echo("head");
    expect(await ids()).toEqual([]);
  });

  it.each(["echo", "error end"] as const)(
    "keeps the delivery established by the %s when the head's admission reply is lost",
    async (seen) => {
      await sendInOrder("first", "head", "tail");
      end("first", "cancelled");
      const wire = pendingStart();
      const resuming = resumeInWindow();
      await vi.waitFor(() => expect(starts()).toEqual(["first", "head"]));
      emit({ type: "turn.started", sessionId, turnId: "head", timestamp: seq });
      if (seen === "echo") echo("head");
      else end("head", "error");
      wire.reject(new Error("connection lost"));
      await resuming;
      expect(starts()).toEqual(["first", "head"]);
      expect(await ids()).toEqual(seen === "echo" ? ["tail"] : ["head", "tail"]);
      await resumeInWindow();
      if (seen === "echo") {
        expect(starts()).toEqual(["first", "head"]);
        end("head");
        await vi.waitFor(() => expect(starts()).toEqual(["first", "head", "tail"]));
      }
      const retry = engine.startTurn.mock.lastCall![0];
      expect(starts()).toHaveLength(3);
      expect(retry.turnId).not.toBe("head");
      expect(retry.input).toBe(seen === "echo" ? "Message tail" : "Message head");
    }
  );

  it("keeps a confirmed stop's final echo when a second Stop finds the turn gone", async () => {
    await sendInOrder("first", "waiting");
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
    await resumeInWindow();
    expect(starts()).toEqual(["first", "fresh", "waiting"]);
    expect(await queue()).toEqual({ paused: null, items: [] });
  });

  it("immediately returns an unechoed head and closes its card when Stop finds no active turn", async () => {
    await sendInOrder("first", "head", "tail");
    end("first", "cancelled");
    engine.startTurn.mockResolvedValueOnce(undefined);
    await resumeInWindow();
    question("head");
    expect(pendingFor(sessionId)).toHaveLength(1);
    expect((await queue()).items[0]).toMatchObject({ id: "head", state: "sending" });

    engine.cancelTurn.mockResolvedValueOnce({ outcome: "no_active_turn" });
    await expect(stop()).resolves.toEqual({ unconfirmed: false });
    expect(engine.cancelTurn.mock.calls).toEqual([[sessionId, "head"]]);
    expect(wireTurnId()).toBeUndefined();
    expect(pendingFor(sessionId)).toEqual([]);
    expect(await run(api.session, { sessionId })).toMatchObject({ status: "idle" });
    expect(await queue()).toMatchObject({
      paused: "stopped",
      items: [waitingRow("head"), waitingRow("tail")],
    });
    await resumeInWindow();
    expect(await run(api.session, { sessionId })).toMatchObject({ status: "working" });
    const retry = engine.startTurn.mock.lastCall![0];
    expect(starts()).toEqual(["first", "head", retry.turnId]);
    expect(retry.turnId).not.toBe("head");
    expect(retry.input).toBe("Message head");
    expect(await ids()).toEqual(["tail"]);

    await stopped(retry.turnId);
    end(retry.turnId, "cancelled");
    expect(await queue()).toMatchObject({ paused: "stopped", items: [{ id: "tail" }] });
  });

  it.each(["end", "watchdog"] as const)(
    "holds new sends and Resume until the confirmed turn's %s",
    async (settlement) => {
      vi.useFakeTimers();
      await sendInOrder("A", "B");
      plan("A");
      const [card] = pendingFor(sessionId);
      await expect(stopped("A")).resolves.toEqual({ unconfirmed: false });
      expect(answer(card!.requestId, { result: { approved: true } })).toBe(false);
      await resumeInWindow();
      await expect(send("C")).resolves.toEqual({ turnId: "C", queued: true });
      expect(starts()).toEqual(["A"]);
      expect(await run(api.session, { sessionId })).toMatchObject({ status: "working" });
      if (settlement === "end") end("A", "cancelled");
      else await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(() => expect(starts()).toEqual(["A", "B"]));
      expect(await queue()).toMatchObject({ paused: null, items: [{ id: "C" }] });
      expect(await run(api.session, { sessionId })).toMatchObject({ status: "working" });
    }
  );

  it.each(["end", "watchdog", "pending start"])(
    "starts only the person's post-Stop send when A settles (%s)",
    async (order) => {
      vi.useFakeTimers();
      const wire = order === "pending start" ? pendingStart() : undefined;
      const active = send("A");
      await vi.waitFor(() => expect(starts()).toEqual(["A"]));
      await send("R");
      const stopping = stopped("A");
      await sendInOrder("P", "P");
      expect(starts()).toEqual(["A"]);
      wire?.resolve();
      await Promise.all([active, stopping]);
      if (order === "watchdog") await vi.advanceTimersByTimeAsync(15_000);
      else end("A", "cancelled");
      await vi.waitFor(() => expect(starts()).toEqual(["A", "P"]));
      end("P");
      expect(await queue()).toMatchObject({ paused: "stopped", items: [waitingRow("R")] });
      expect(starts()).toEqual(["A", "P"]);
    }
  );

  it.each(["watchdog", "replay gap"] as const)(
    "retries B after the %s gave up A with an empty queue and the engine was still busy",
    async (lost) => {
      vi.useFakeTimers();
      await send("A");
      engine.cancelTurn.mockResolvedValueOnce({ outcome: "cancelled", turnId: "A" });
      if (lost === "watchdog") {
        await stop();
        await vi.advanceTimersByTimeAsync(15_000);
      } else {
        gap("replay_failed");
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(wireTurnId()).toBeUndefined();
      const {
        status: prior,
        error_message,
        error_category,
      } = (await run(api.session, { sessionId }))!;
      engine.startTurn.mockRejectedValueOnce(busyReply("A"));
      await expect(send("B")).resolves.toEqual({ turnId: "B", queued: true });
      expect(wireTurnId()).toBeUndefined();
      expect(await run(api.session, { sessionId })).toMatchObject({
        status: prior,
        error_message,
        error_category,
      });
      const published = vi.fn(() =>
        db
          .prepare("SELECT status, error_message, error_category FROM sessions WHERE id = ?")
          .get(sessionId)
      );
      const unwatch = onInvalidate(published);
      end("A", "cancelled");
      unwatch();
      expect(published).toHaveReturnedWith({ status: prior, error_message, error_category });
      await vi.advanceTimersByTimeAsync(0);
      expect(starts()).toEqual(["A", "B", "B"]);
      expect((await queue()).paused).toBeNull();
      expect(await ids()).toEqual([]);
      end("B");
      expect(await run(api.session, { sessionId })).toMatchObject({ status: "idle" });
    }
  );

  it.each(["watchdog", "replay gap"] as const)(
    "keeps the %s settlement after a busy send and an unconfirmed Stop without a holder",
    async (settlement) => {
      vi.useFakeTimers();
      await send("A");
      engine.cancelTurn.mockResolvedValueOnce({ outcome: "cancelled", turnId: "A" });
      if (settlement === "watchdog") {
        await stop();
        await vi.advanceTimersByTimeAsync(15_000);
      } else {
        gap("replay_failed");
        await vi.advanceTimersByTimeAsync(0);
      }
      const { status, error_message, error_category } = (await run(api.session, { sessionId }))!;
      expect(status).toBe(settlement === "watchdog" ? "idle" : "error");
      engine.startTurn.mockRejectedValueOnce(busyReply("A"));
      await expect(send("B")).resolves.toEqual({ turnId: "B", queued: true });
      expect(holdingTurn(sessionId)).toBeUndefined();

      engine.cancelTurn.mockRejectedValueOnce(new Error("link dropped"));
      await expect(stop()).resolves.toEqual({ unconfirmed: true });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await run(api.session, { sessionId })).toMatchObject({
        status,
        error_message,
        error_category,
      });
      expect(await queue()).toMatchObject({ paused: "stopped", items: [waitingRow("B")] });
    }
  );

  it("refreshes only the given-up chat, keeps its streaming sentence, and accepts its late engine end", async () => {
    vi.useFakeTimers();
    const frames: { type: string; id: string; data?: api.SessionEvent }[] = [];
    const window = addConnection(
      { close() {}, send: (frame) => frames.push(JSON.parse(String(frame))) },
      null
    );
    subscribe(window, "transcript", api.sessionEvents, { sessionId });
    subscribe(window, "other", api.sessionEvents, { sessionId: crypto.randomUUID() });
    await send("A");
    reply("A", "The fix", "streaming");
    emit({
      type: "message.part.delta",
      sessionId,
      turnId: "A",
      messageId: "reply-A",
      outputIndex: 1,
      partIndex: 0,
      partId: "part-A",
      delta: { type: "text", text: " is ready." },
      timestamp: seq,
    });
    await stopped("A");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(frames.filter((frame) => frame.type === "q:reset").map((frame) => frame.id)).toEqual([
      "transcript",
    ]);
    const page = await run(api.messages, { sessionId });
    const row = page.messages.find((message) => message.id === "reply-A")!;
    const reset = frames.findIndex((frame) => frame.type === "q:reset");
    let fold = emptyConversation();
    for (const frame of frames.slice(reset + 1)) {
      if (frame.id === "transcript" && frame.data?.type === "event")
        fold = reduceConversationWithChanges(fold, frame.data.envelope.event).state;
    }
    const parts = findConversationMessage(fold, row.id)?.parts ?? row.parts;
    expect(parts).toMatchObject([{ type: "text", text: "The fix is ready." }]);
    expect((await run(api.messages, { sessionId })).turns).toContainEqual(
      expect.objectContaining({ turnId: "A", stopReason: "cancelled" })
    );
    emit({
      type: "turn.ended",
      sessionId,
      turnId: "A",
      stopReason: "end_turn",
      timestamp: seq,
      cost: 0.25,
    });
    expect((await run(api.messages, { sessionId })).turns).toContainEqual(
      expect.objectContaining({ turnId: "A", stopReason: "end_turn", cost: 0.25 })
    );
  });

  it("settles a confirmed stop and restores working when the successor starts after a late end", async () => {
    vi.useFakeTimers();
    const frames: unknown[] = [];
    const window = addConnection(
      { close() {}, send: (frame) => frames.push(JSON.parse(String(frame))) },
      null
    );
    subscribe(window, "transcript", api.sessionEvents, { sessionId });
    await sendInOrder("first", "A", "tail");
    engine.startTurn.mockResolvedValueOnce(undefined);
    end("first");
    await vi.waitFor(() => expect(wireTurnId()).toBe("A"));
    await steer("unread");
    question("A");
    await expect(stopped("A")).resolves.toEqual({ unconfirmed: false });
    expect((await queue()).items.map((item) => item.state)).toEqual([
      "sending",
      "steering",
      "waiting",
    ]);
    expect(await run(api.session, { sessionId })).toMatchObject({ status: "working" });

    await vi.advanceTimersByTimeAsync(15_000);
    expect(frames).not.toContainEqual(
      expect.objectContaining({ type: "q:reset", id: "transcript" })
    );
    expect(wireTurnId()).toBeUndefined();
    expect(pendingFor(sessionId)).toEqual([]);
    expect(await run(api.session, { sessionId })).toMatchObject({
      status: "idle",
      error_message: null,
    });
    expect(await queue()).toMatchObject({
      paused: "stopped",
      items: [waitingRow("A"), { text: "Message unread", state: "waiting" }, { id: "tail" }],
    });

    const release = holdAppSetup();
    const resume = resumeInWindow();
    const startedAt = seq;
    emit({ type: "turn.started", sessionId, turnId: "A", timestamp: startedAt });
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
      expect.objectContaining({ turnId: "A", startedAt, cost: 0.25 })
    );
    release();
    await resume;
    expect(starts()).toHaveLength(3);
    expect(wireTurnId()).toBe(starts()[2]);
    expect(await run(api.session, { sessionId })).toMatchObject({ status: "working" });
  });

  it("keeps Resume when the turn whose replay failed finally ends", async () => {
    await sendInOrder("A", "B");
    engine.cancelTurn.mockResolvedValueOnce({ outcome: "unconfirmed", turnId: "A" });
    gap("replay_failed");
    await vi.waitFor(async () => expect((await queue()).paused).toBe("stopped"));
    await resumeInWindow();
    end("A", "cancelled");
    await vi.waitFor(() => expect(starts()).toEqual(["A", "B"]));
  });

  it("keeps a waiting row paused when a normal end arrives before the cancel reply", async () => {
    await sendInOrder("first", "waiting");
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
    await sendInOrder("A", "B", "C");
    const cancel = Promise.withResolvers<TurnCancelResult>();
    engine.cancelTurn.mockReturnValueOnce(cancel.promise);
    const stopping = stop();
    expect(engine.cancelTurn.mock.calls).toEqual([[sessionId, "A"]]);
    end("A");

    const releaseApps = holdAppSetup();
    const resuming = resumeInWindow();
    expect(wireTurnId()).toBeUndefined();
    cancel.resolve({ outcome: "no_active_turn" });
    await stopping;
    expect(await run(api.session, { sessionId })).toMatchObject({ status: "working" });
    const duringSetup = await queue();
    releaseApps();
    await resuming;
    expect(duringSetup).toMatchObject({
      paused: null,
      items: [{ id: "B", state: "sending" }, waitingRow("C")],
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
          : createDeusHost().send(windowCaller, sessionId, {
              turnId: "starting",
              message: "hello",
              origin: fromPerson,
            });
      await vi.waitFor(() => expect(resolveTurnApps).toHaveBeenCalled());
      expect(await run(api.session, { sessionId })).toMatchObject({ status: "working" });
      expect(wireTurnId()).toBeUndefined();
      const reason = "Stopped before it started.";
      const changes: string[] = [];
      const unwatch = onInvalidate((resources) => changes.push(...resources));
      await Promise.all([
        expect(sending).rejects.toMatchObject(
          sender === "direct"
            ? { statusCode: 409, message: reason }
            : { code: "unsupported", message: expect.stringContaining(reason) }
        ),
        expect(stop()).resolves.toEqual({ unconfirmed: false }),
      ]);
      unwatch();
      expect(changes).toContain("queuedMessages");
      expect(await queue()).toEqual({ paused: null, items: [] });
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
      expect(wireTurnId()).toBe("next");
      expect(await run(api.session, { sessionId })).toMatchObject({ status: "working" });
    }
  );

  describe("Stop while a queued head is starting", () => {
    let releaseApps: () => void;

    beforeEach(async () => {
      await sendInOrder("first", "head", "next");
      releaseApps = holdAppSetup();
      end("first");
      expect(wireTurnId()).toBeUndefined();
    });

    it("returns the head first and pauses without waiting for its apps", async () => {
      await expect(stop()).resolves.toEqual({ unconfirmed: false });
      expect(await run(api.session, { sessionId })).toMatchObject({
        status: "idle",
        error_message: null,
      });
      expect(await queue()).toMatchObject({
        paused: "stopped",
        items: [waitingRow("head"), waitingRow("next")],
      });
      expect(starts()).toEqual(["first"]);
      expect(engine.cancelTurn).not.toHaveBeenCalled();

      await resumeInWindow();
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
      expect(wireTurnId()).toBeUndefined();
      expect(engine.cancelTurn.mock.calls).toEqual([[sessionId, "head"]]);
      expect(starts()).toEqual(["first", "head"]);
      expect(await queue()).toMatchObject({ paused: "stopped", items: [{ id: "next" }] });
    });

    it("settles the chat and returns the head if the wire times out during Stop", async () => {
      const wire = pendingStart();
      releaseApps();
      await vi.waitFor(() => expect(starts()).toEqual(["first", "head"]));
      expect(wireTurnId()).toBe("head");
      const stopping = stop();
      wire.reject(
        new WireRequestError(WIRE_ERROR_CODES.internalError, "request timed out: turn/start")
      );
      await expect(stopping).resolves.toEqual({ unconfirmed: false });
      expect(wireTurnId()).toBeUndefined();
      expect(engine.cancelTurn).not.toHaveBeenCalled();
      expect(await run(api.session, { sessionId })).toMatchObject({
        status: "error",
        error_message: "request timed out: turn/start",
      });
      expect(await queue()).toMatchObject({
        paused: "stopped",
        items: [waitingRow("head"), waitingRow("next")],
      });
    });

    it("leaves a manual turn working if the head ends before its admission reply", async () => {
      const admit = holdAdmission();
      engine.cancelTurn.mockResolvedValueOnce({ outcome: "no_active_turn" });
      releaseApps();
      await vi.waitFor(() => expect(wireTurnId()).toBe("head"));
      const stopping = stop();
      expect((await queue()).items[0]).toMatchObject({ id: "head", state: "sending" });
      echo("head");
      end("head");
      expect(await ids()).toEqual(["next"]);
      const releaseManual = holdAppSetup();
      const manual = send("manual");
      expect(wireTurnId()).toBeUndefined();
      expect(await run(api.session, { sessionId })).toMatchObject({ status: "working" });
      admit();
      await expect(stopping).resolves.toEqual({ unconfirmed: false });
      expect(await run(api.session, { sessionId })).toMatchObject({ status: "working" });
      expect(engine.cancelTurn).not.toHaveBeenCalled();
      releaseManual();
      await manual;
      expect(wireTurnId()).toBe("manual");
      expect(await queue()).toMatchObject({ paused: "stopped", items: [{ id: "next" }] });
    });
  });

  it("pauses after a failed turn, and keeps unread steers at the front in request order", async () => {
    await sendInOrder("first", "waiting");
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
      await sendInOrder("first", "waiting");
      await steer("a");
      if (kind === "unconfirmed")
        engine.cancelTurn.mockResolvedValue({ outcome: "unconfirmed", turnId: "first" });
      else engine.cancelTurn.mockRejectedValue(new Error("link closed"));
      await expect(stop()).resolves.toEqual({ unconfirmed: true });
      expect((await queue()).paused).toBe("stopped");
      emit({ type: "session.ended", sessionId, reason: "idle", timestamp: seq });
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
      await sendInOrder("A", "B");
      engine.cancelTurn.mockResolvedValueOnce({ outcome: "unconfirmed", turnId: "A" });
      await expect(stop()).resolves.toEqual({ unconfirmed: true });
      end("A", "cancelled");

      const releaseApps = holdAppSetup();
      engine.startTurn.mockResolvedValue(undefined);
      const firstResume = resumeInWindow();
      expect(wireTurnId()).toBeUndefined();
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
      await sendInOrder("A", "B", "C");
      end("A", "cancelled");
      engine.startTurn.mockResolvedValueOnce(undefined);
      await resumeInWindow();
      emit({ type: "turn.started", sessionId, turnId: "B", timestamp: seq });
      const echo = [...echoFrames("B", "Message B")];
      const close = echo.pop()!;
      for (const frame of echo) emit(frame);
      gap("server_restarted");
      expect(await queue()).toMatchObject({
        paused: "failed",
        items: [waitingRow("B"), waitingRow("C")],
      });
      emit(close);
      await resumeInWindow();
      expect(starts()).toEqual(["A", "B", "C"]);
      expect(await ids()).toEqual([]);
    });

    it("drains both rows when the predecessor ends before its lost start reply", async () => {
      const wire = pendingStart();
      const predecessor = send("A");
      await vi.waitFor(() => expect(starts()).toEqual(["A"]));
      emit({ type: "turn.started", sessionId, turnId: "A", timestamp: seq });
      await sendInOrder("B", "C");
      const releaseApps = holdAppSetup();
      engine.startTurn.mockResolvedValueOnce(undefined);
      end("A");
      expect(wireTurnId()).toBeUndefined();
      wire.reject(new Error("A lost its admission reply"));
      await expect(predecessor).rejects.toThrow("A lost its admission reply");
      const duringSetup = await queue();
      expect(await run(api.session, { sessionId })).toMatchObject({
        status: "working",
        error_message: null,
      });
      releaseApps();
      await vi.waitFor(() => expect(starts()).toEqual(["A", "B"]));
      emit({ type: "turn.started", sessionId, turnId: "B", timestamp: seq });
      echo("B");
      expect(duringSetup).toMatchObject({
        paused: null,
        items: [{ id: "B", state: "sending" }, waitingRow("C")],
      });
      expect(await queue()).toMatchObject({ paused: null, items: [{ id: "C" }] });
      end("B");
      await vi.waitFor(() => expect(starts()).toEqual(["A", "B", "C"]));
      expect(await queue()).toEqual({ paused: null, items: [] });
    });
  });

  it.each(["before", "after"] as const)(
    "returns the sending head ahead of unread steers when a gap lands %s admission",
    async (when) => {
      await sendInOrder("first", "head", "waiting");
      end("first", "cancelled");
      const admit = holdAdmission();
      const resuming = resumeInWindow();
      await vi.waitFor(() => expect(wireTurnId()).toBe("head"));
      if (when === "after") {
        admit();
        await resuming;
      }
      await steer("a");
      gap("server_restarted");
      const recovered = {
        paused: "failed",
        items: [waitingRow("head"), { text: "Message a", state: "waiting" }, waitingRow("waiting")],
      };
      expect(await queue()).toMatchObject(recovered);
      if (when === "before") {
        admit();
        await resuming;
      }
      expect(starts()).toEqual(["first", "head"]);
      expect(await queue()).toMatchObject(recovered);
      // The engine can replay the terminal after the gap gave up live ownership.
      expect(wireTurnId()).toBeUndefined();
      end("head", "cancelled");
      expect(await queue()).toMatchObject(recovered);
      expect(await resumeQueuedMessages(sessionId, fromChat)).toMatchObject({ outcome: "resumed" });
    }
  );

  it.each([true, false])(
    "steers a queued row using the running harness's images capability (%s)",
    async (images) => {
      engine.images = images;
      await sendInOrder("first", "waiting");
      const picture = { type: "image", mimeType: "image/png", data: "cGljdHVyZQ==" };
      await run(api.sendMessage, {
        ...message("picture"),
        turnId: "picture",
        content: JSON.stringify([picture]),
      });
      await steerRow("picture");
      const attempt = lastSteerId();
      expect(attempt).not.toBe("picture");
      expect(engine.steerTurn).toHaveBeenCalledWith({
        sessionId,
        turnId: "first",
        steerId: attempt,
        input: images ? [picture] : [{ type: "text", text: expect.stringContaining("omitted") }],
      });
      expect(await ids()).toEqual(["waiting", "picture"]);
      expect(await read("picture")).toEqual({ content: null });
      expect(await remove("picture")).toEqual({ removed: false });
      echo("first", "unrelated");
      expect(await ids()).toEqual(["waiting", "picture"]);
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
    const reply = pendingSteer();
    const receipt = steer("a");
    const [rowId] = await ids();
    echo("first", lastSteerId());
    reply.reject(new Error("connection closed"));
    await receipt;
    await steerRow(rowId!);
    expect(engine.steerTurn).toHaveBeenCalledOnce();
    end("first");
    expect(await ids()).toEqual([]);
    expect(starts()).toEqual(["first"]);
  });

  it("a steer echoed after its RPC timed out never runs a second time", async () => {
    await send("first");
    engine.steerTurn.mockRejectedValueOnce(new Error("timed out"));
    await steer("a");
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
      await sendInOrder("first", "waiting");
      engine.steerTurn.mockRejectedValueOnce(new Error("timed out"));
      await steer("a");
      const rows = (await queue()).items;
      expect(rows).toMatchObject([{ text: "Message a", state: "steering" }, { id: "waiting" }]);
      const rowId = rows[0]!.id;
      end("first", reason, reason === "cancelled" ? [lastSteerId()] : undefined);
      if (reason === "cancelled") {
        expect(await queue()).toMatchObject({
          paused: "stopped",
          items: [{ id: rowId, state: "waiting" }, { id: "waiting" }],
        });
        await resumeInWindow();
      }
      await vi.waitFor(() => expect(starts()).toEqual(["first", rowId]));
      expect(await ids()).toEqual(["waiting"]);
      end(rowId);
      await vi.waitFor(() => expect(starts()).toEqual(["first", rowId, "waiting"]));
    }
  );

  it.each([false, true])(
    "runs a recovered promoted row as its own turn only while unread (late read: %s)",
    async (read) => {
      await sendInOrder("first", "row");
      await steerRow("row");
      const firstAttempt = lastSteerId();
      end("first", "cancelled", [firstAttempt]);
      await send("fresh");
      await steerRow("row");
      if (read) echo("first", firstAttempt);
      expect((await queue()).items).toMatchObject(read ? [] : [waitingRow("row")]);
      end("fresh");
      await resumeInWindow();
      expect(starts()).toEqual(read ? ["first", "fresh"] : ["first", "fresh", "row"]);
      expect(engine.steerTurn).toHaveBeenCalledOnce();
    }
  );

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
    await steerRow(queued.turnId);
    end("first");
    expect(starts()).toEqual(["first"]);
  });

  it.each(["no_active_turn", "unsupported"] as const)(
    "moves a steer the engine refused to the head (%s)",
    async (outcome) => {
      await sendInOrder("first", "waiting");
      engine.steerTurn.mockResolvedValue({ outcome });
      await steer("a");
      const rows = (await queue()).items;
      expect(rows).toMatchObject([{ text: "Message a", state: "waiting" }, { id: "waiting" }]);
      end("first");
      await vi.waitFor(() => expect(starts()).toEqual(["first", rows[0]!.id]));
    }
  );

  it("sends a steer as its own turn if the working chat has just gone idle", async () => {
    await send("first");
    end("first");
    await steer("a");
    expect(engine.steerTurn).not.toHaveBeenCalled();
    expect(engine.startTurn.mock.calls.map(([turn]) => turn.input)).toEqual([
      "Message first",
      "Message a",
    ]);
  });

  it("a no_active_turn reply arriving after the end cannot enqueue a steer twice", async () => {
    await sendInOrder("first", "waiting");
    const reply = pendingSteer();
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
      await sendInOrder("first", "a", "b");
      db.prepare("UPDATE sessions SET status = ? WHERE id = ?").run(status, sessionId);
      await steer("c");
      await steerRow("b");
      expect(engine.steerTurn).not.toHaveBeenCalled();
      expect((await queue()).items).toMatchObject([
        { id: "a" },
        { id: "b" },
        { text: "Message c" },
      ]);
    }
  );

  it.each(["replay gap", "confirmed cancel"] as const)(
    "withdraws a question when a %s settles its turn without a terminal event",
    async (settlement) => {
      await send("first");
      question("first");
      const [card] = pendingFor(sessionId);
      expect(card?.method).toBe("askUserQuestion");
      if (settlement === "replay gap") {
        gap("server_restarted");
      } else {
        await stopped("first");
        expect(wireTurnId()).toBe("first");
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

  it("finishing A's delayed question response leaves B's plan waiting", async () => {
    await send("A");
    const finishQuestion = Promise.withResolvers<void>();
    const relay = toolRelay.relay;
    const questionRelay = vi
      .spyOn(toolRelay, "relay")
      .mockImplementationOnce((request) => relay(request).finally(() => finishQuestion.promise));
    question("A");
    questionRelay.mockRestore();
    await outliveStop("A");
    engine.startTurn.mockRejectedValueOnce(busyReply("A"));
    await send("B");
    end("A");
    await vi.waitFor(() => expect(starts()).toEqual(["A", "B", "B"]));
    plan("B");
    finishQuestion.resolve();
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
        await stopped("first");
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
      if (reason === "cancelled") await resumeInWindow();
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
    await sendInOrder("first", "again");
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

  it("converges on the queued turn and then its stored echo for the same text and sender", async () => {
    vi.useFakeTimers();
    await send("first");
    const input = { ...message("next"), turnId: "next" };
    const queued = { position: 1 };
    await expect(enqueueMessage(input, fromAssistant)).resolves.toEqual(queued);
    await expect(enqueueMessage(input, fromAssistant)).resolves.toEqual(queued);
    await expect(enqueueMessage(input, fromChat)).rejects.toThrow(/different message/i);
    expect((await queue()).items).toMatchObject([
      { id: "next", state: "waiting", origin: fromAssistant },
    ]);
    end("first");
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.startTurn.mock.lastCall![0]).toMatchObject({
      turnId: "next",
      origin: fromAssistant,
    });
    end("next");
    await vi.runAllTimersAsync(); // Expire in-memory admissions; the retry has only the stored echo.
    await expect(enqueueMessage(input, fromAssistant)).resolves.toEqual({});
    await expect(enqueueMessage(input, fromChat)).rejects.toThrow(/different message/i);
    expect(await ids()).toEqual([]);
    expect(starts()).toEqual(["first", "next"]);
  });

  it.each([false, true])(
    "recognizes a picture message from its stored echo (images supported: %s)",
    async (supported) => {
      vi.useFakeTimers();
      engine.images = supported;
      const parts = [
        { type: "text", text: "Use " },
        { type: "image", mimeType: "image/png", data: "cGljdHVyZQ==" },
        { type: "text", text: "this picture" },
      ];
      const input = { ...message("picture"), turnId: "picture", content: JSON.stringify(parts) };
      await run(api.sendMessage, input);
      end("picture");
      await vi.runAllTimersAsync();
      await expect(run(api.sendMessage, input)).resolves.toEqual({ turnId: "picture" });
      if (supported) {
        const changed = { ...input, content: input.content.replace("cGljdHVyZQ==", "b3RoZXI=") };
        await expect(run(api.sendMessage, changed)).rejects.toThrow(/different message/i);
        const reordered = JSON.stringify([parts[1], parts[0], parts[2]]);
        await expect(run(api.sendMessage, { ...input, content: reordered })).rejects.toThrow(
          /different message/i
        );
      }
      expect(starts()).toEqual(["picture"]);
    }
  );

  it("refuses a durable read-steer retry when only the picture bytes change", async () => {
    await send("active");
    const host = createDeusHost();
    const steerPicture = (data: string) =>
      host.steer!(chatCaller, sessionId, {
        turnId: "active",
        steerId: "picture",
        origin: fromChat,
        message: JSON.stringify([
          { type: "text", text: "Look here" },
          { type: "image", mimeType: "image/png", data },
        ]),
      });
    await steerPicture("cGljdHVyZQ==");
    echo("active", "picture", engine.steerTurn.mock.lastCall![0].input, fromChat);
    end("active");
    await expect(steerPicture("cGljdHVyZQ==")).resolves.toEqual({ outcome: "accepted" });
    await expect(steerPicture("b3RoZXI=")).rejects.toMatchObject({
      refusal: { detail: expect.stringMatching(/different message/i) },
    });
    expect(engine.steerTurn).toHaveBeenCalledOnce();
  });

  it("counts agents' waiting messages and unread steers together and leaves room for the person", async () => {
    await sendInOrder("first", "mine");
    for (const id of ["a", "b", "c", "d"])
      await enqueueMessage({ ...message(id), turnId: id }, fromChat);
    await steerMessage({ ...message("unread"), turnId: "first" }, fromAssistant);
    const unread = lastSteerId();
    const overflow = { ...message("overflow"), turnId: "overflow" };
    const refusal = {
      constructor: QueueLimitError,
      limit: "agents",
      message: expect.stringContaining("5 messages from agents waiting"),
    };
    await expect(enqueueMessage(overflow, fromChat)).rejects.toMatchObject(refusal);
    await expect(
      steerMessage({ ...overflow, turnId: "first" }, fromAssistant)
    ).rejects.toMatchObject(refusal);
    await expect(enqueueMessage({ ...message("a"), turnId: "a" }, fromChat)).resolves.toEqual({
      position: 3,
    });
    await steerRow("d");
    const readSteer = engine.steerTurn.mock.lastCall![0];
    expect(readSteer.origin).toEqual(fromChat);
    echo("first", readSteer.steerId, readSteer.input, readSteer.origin);
    await expect(enqueueMessage(overflow, fromAssistant)).resolves.toEqual({
      position: 6,
    });
    await expect(send("also-mine")).resolves.toEqual({ turnId: "also-mine", queued: true });
    end("first", "cancelled", [unread]);
    const held = await queue();
    expect(held.paused).toBe("stopped");
    expect(held.items[0]).toMatchObject({
      state: "waiting",
      text: message("unread").content,
      origin: fromAssistant,
    });
    expect(held.items.filter((row) => row.origin)).toHaveLength(5);
  });

  it("holds 20 sending, steering and waiting rows and refuses a 21st send or composer steer", async () => {
    await sendInOrder("first", "head");
    engine.startTurn.mockImplementationOnce(async ({ turnId }) => {
      emit({ type: "turn.started", sessionId, turnId, timestamp: seq });
    });
    end("first");
    await vi.waitFor(() => expect(wireTurnId()).toBe("head"));
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
    await expect(send("overflow")).rejects.toMatchObject({
      constructor: QueueLimitError,
      limit: "total",
      message: refusal,
    });
    await expect(steer("overflow")).rejects.toThrow(refusal);
    expect(engine.steerTurn).toHaveBeenCalledOnce();
    expect((await queue()).items).toEqual(rows);

    await expect(send("waiting-0")).resolves.toEqual({ turnId: "waiting-0", queued: true });
    await steerRow("waiting-0");
    echo("head");
    await send("last");
    end(
      "head",
      "cancelled",
      engine.steerTurn.mock.calls.map(([p]) => p.steerId!)
    );
    expect(await ids()).toEqual([rows[1]!.id, ...waiting, "last"]);
    await expect(send("manual")).resolves.toEqual({ turnId: "manual" });
  });

  it.each(["before", "after"] as const)(
    "queues two callers of a losing admission once when the winner ends %s the busy reply",
    async (when) => {
      await send("winner");
      await outliveStop("winner");
      const admission = pendingStart();
      const receipts = Promise.all([send("loser"), send("loser")]);
      await vi.waitFor(() => expect(starts()).toEqual(["winner", "loser"]));
      expect(await ids()).toEqual([]);
      if (when === "before") end("winner");
      admission.reject(busyReply("winner"));
      expect(await receipts).toEqual([
        { turnId: "loser", queued: true },
        { turnId: "loser", queued: true },
      ]);
      if (when === "after") {
        expect(await ids()).toEqual(["loser"]);
        end("winner");
      }
      await vi.waitFor(() => expect(starts()).toEqual(["winner", "loser", "loser"]));
      expect(await ids()).toEqual([]);
    }
  );

  it("pauses rows accepted during an admission that later fails", async () => {
    const reply = pendingStart();
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
      await sendInOrder("first", "a", "b");
      if (failure === "busy") await outliveStop("first");
      engine.startTurn.mockRejectedValueOnce(
        failure === "failed" ? new Error("engine unavailable") : busyReply("first")
      );
      if (failure === "busy") await resumeInWindow();
      else end("first");
      await vi.waitFor(async () =>
        expect(await queue()).toMatchObject({
          paused: "failed",
          items: [waitingRow("a"), waitingRow("b")],
        })
      );
      if (failure === "failed") {
        await resumeInWindow();
        const retry = engine.startTurn.mock.lastCall![0];
        expect(starts()).toEqual(["first", "a", retry.turnId]);
        expect(retry.turnId).not.toBe("a");
        expect(retry.input).toBe("Message a");
      } else {
        end("first");
        await vi.waitFor(() => expect(starts()).toEqual(["first", "a", "a"]));
      }
      expect(await ids()).toEqual(["b"]);
    }
  );

  it("retries the head when the competing turn ended before the busy admission reply", async () => {
    await sendInOrder("first", "next");
    await outliveStop("first");
    const reply = pendingStart();
    const resuming = resumeInWindow();
    await vi.waitFor(() => expect(starts()).toEqual(["first", "next"]));
    end("first");
    reply.reject(busyReply("first"));
    await resuming;
    await vi.waitFor(() => expect(starts()).toEqual(["first", "next", "next"]));
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

  it("replays a cloud turn whose raw text is valid part JSON after its admission expires", async () => {
    vi.useFakeTimers();
    db.exec("UPDATE workspaces SET kind = 'cloud'");
    vi.spyOn(cloud, "hasLiveCloudSession").mockReturnValue(true);
    const start = vi.spyOn(cloud, "startCloudTurn").mockImplementation(async (_, turnId, text) => {
      emit({ type: "turn.started", sessionId, turnId, timestamp: seq });
      echo(turnId, undefined, text);
      end(turnId);
    });
    const parts = [{ type: "text", text: "hello" }];
    const sendCloud = (content: string) =>
      run(api.sendMessage, {
        ...message("cloud"),
        turnId: "cloud",
        content,
        thinkingLevel: "medium",
      });
    await sendCloud(JSON.stringify(parts));
    await vi.runAllTimersAsync();
    await expect(sendCloud(JSON.stringify(parts))).resolves.toEqual({ turnId: "cloud" });
    await expect(sendCloud(JSON.stringify(parts, null, 2))).rejects.toThrow(/different message/i);
    expect(start).toHaveBeenCalledOnce();
  });

  it("the operator still hears busy while a person's message waits", async () => {
    await sendInOrder("first", "person");
    await expect(
      createDeusHost().send(windowCaller, sessionId, {
        turnId: "operator",
        message: "follow up",
        origin: fromPerson,
      })
    ).rejects.toMatchObject({ refusal: { code: "busy" } });
    expect(await ids()).toEqual(["person"]);
  });

  it.each(["archive", "hide", "delete"])(
    "discards waiting messages and in-flight steer replies on %s",
    async (action) => {
      await sendInOrder("first", "waiting");
      const reply = pendingSteer();
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

  it("keeps the restored workspace's new queue when an archived steer's conflict arrives", async () => {
    await send("T");
    const reply = pendingSteer();
    const conflict = expect(steer("old")).rejects.toThrow("A different message was already sent");
    db.exec("UPDATE workspaces SET state = 'archived' WHERE id = 'w'");
    invalidate(["workspaces", "sessions"]);
    db.exec("UPDATE workspaces SET state = 'ready' WHERE id = 'w'");
    invalidate(["workspaces", "sessions"]);
    await send("new");
    reply.reject(new WireRequestError(WIRE_ERROR_CODES.turnConflict, "different input"));
    await conflict;
    expect(await ids()).toEqual(["new"]);
    end("T");
    await vi.waitFor(() => expect(starts()).toEqual(["T", "new"]));
  });

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
          const receipt = state === "sending" ? "message.ended" : "message.started";
          if (state === "steering" || event.type === receipt)
            expect(snapshot.data?.items).toEqual([]);
          else expect(snapshot.data?.items).toMatchObject([{ text, state }]);
          if (event.type === receipt) {
            const cleared = frames.findIndex((f) => f.data?.items?.length === 0);
            expect(cleared).toBeGreaterThan(frames.indexOf(published));
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

describe("the operator's queue and steer contract", () => {
  const caller = chatCaller;
  const host = createDeusHost();
  const input = { turnId: "active", steerId: "given", message: "Review this", origin: fromChat };
  const steer = (changes: Partial<typeof input> = {}) =>
    host.steer!(caller, sessionId, { ...input, ...changes });
  const enqueue = (id: string, message = id) =>
    host.queue!(caller, sessionId, { turnId: id, message, origin: fromChat });
  const fact = () => host.turn(caller, sessionId, "active");
  const sendFromChat = (message: string, when?: "queue") =>
    createOperator(host).call(
      "send_message",
      { session: sessionId, message, when, wait: 0 },
      caller
    );

  it("a chat's ordinary send steers the running turn and reports its read", async () => {
    await send("active");
    engine.steerTurn.mockImplementationOnce(async ({ turnId, steerId, input, origin }) => {
      echo(turnId, steerId, input, origin);
      return { outcome: "steered", steerId: steerId! };
    });
    const answer = await sendFromChat("Review");
    expect(answer).toContain('steered "checkout:1" (turn "active"): read.');
    expect(engine.steerTurn.mock.lastCall?.[0]).toMatchObject({
      turnId: "active",
      input: "Review",
      origin: { kind: "session", sessionId: "lead" },
    });
    expect(await ids()).toEqual([]);
    const read = { [lastSteerId()]: "read" };
    expect(await fact()).toMatchObject({ state: "running", steers: read });
    end("active", "end_turn", [lastSteerId()]);
    expect(await fact()).toMatchObject({ state: "ended", steers: read });
  });

  it.each([false, true])(
    "tells a no-wait sender its tracked steer will be kept if unread (question: %s)",
    async (asks) => {
      await send("active");
      if (asks)
        engine.steerTurn.mockImplementationOnce(async ({ turnId, steerId }) => {
          question(turnId);
          return { outcome: "steered", steerId: steerId! };
        });
      const reply = await sendFromChat("Review");
      expect(await fact()).toEqual({ state: "running", steers: {} });
      expect(reply).toContain(
        "accepted, not yet read. If its turn ends first, the product keeps it in its queue."
      );
      expect(reply).toContain("note: 1 message being steered");
      expect(reply).not.toContain("1 message queued");
      if (asks) expect(reply).toMatch(/queue\.\nit waits on .* answer first\./);
    }
  );

  it("uses the same waiting and steering counts in the operator, list, view and manage_queue", async () => {
    await send("active");
    for (const id of ["promote", "waiting", "remove"]) await enqueue(id);
    await queueTool("send_now", "promote");
    const answer = await sendFromChat("fresh");
    const note = "2 messages queued, 2 messages being steered";
    expect(answer).toContain(`note: ${note}`);
    expect((await host.list(caller, {})).find((entry) => entry.id === sessionId)?.note).toBe(note);
    expect((await host.view(caller, sessionId, { last: 1 })).note).toBe(note);
    expect(await queueTool("remove", "remove")).toBe(
      "Removed. 1 message queued, 2 messages being steered."
    );
  });

  it.each(["end_turn", "cancelled"] as const)(
    "shows the ended turn, receipt and recovered row on the first wake after %s",
    async (reason) => {
      await send("active");
      const snapshot = () =>
        Promise.all([fact(), host.view(caller, sessionId, { last: 1 }), queue()] as const);
      const turn = vi.fn(host.turn);
      let ending = false;
      let firstWake: ReturnType<typeof snapshot> | undefined;
      const operator = createOperator({
        ...host,
        turn,
        onChange: (listener) =>
          host.onChange((ids) => {
            if (ending && ids.includes(sessionId)) firstWake ??= snapshot();
            listener(ids);
          }),
      });
      const follow = operator.call(
        "send_message",
        {
          session: sessionId,
          message: "Read the report",
          wait: 5,
        },
        caller
      );
      await vi.waitFor(() => expect(turn).toHaveBeenCalledWith(caller, sessionId, "active"));
      const id = lastSteerId();
      const release = reason === "end_turn" ? holdAppSetup() : undefined;
      ending = true;
      end("active", reason, [id]);
      const answer = await follow;
      const note = release
        ? "1 message being sent"
        : "1 message queued, held: stopped without a recorded Stop; only the person can resume it";
      expect(await firstWake).toMatchObject([
        { state: "ended", steers: { [id]: "queued" } },
        { status: release ? "working" : "stopped", note },
        { items: [{ id, state: release ? "sending" : "waiting" }] },
      ]);
      if (release) {
        expect(await host.turn(caller, sessionId, id)).toEqual({ state: "running", steers: {} });
        release();
        await vi.waitFor(async () =>
          expect(await host.turn(caller, sessionId, id)).toEqual({ state: "running", steers: {} })
        );
      }
      expect(answer).toContain("ended without reading it; the product queued it as its own turn");
      expect(answer).toContain(`note: ${note}`);
    }
  );

  it.each(["stop watchdog", "replay cancel", "restarted engine"] as const)(
    "finishes a real steer follow with the kept receipt when the %s gives up the turn",
    async (source) => {
      vi.useFakeTimers();
      await send("active");
      const turn = vi.fn(host.turn);
      const follow = createOperator({ ...host, turn }).call(
        "send_message",
        { session: sessionId, message: "Review", wait: 60 },
        caller
      );
      await vi.waitFor(() => expect(turn).toHaveBeenCalledWith(caller, sessionId, "active"));
      const id = lastSteerId();
      if (source === "restarted engine") gap("server_restarted");
      else {
        engine.cancelTurn.mockResolvedValueOnce({ outcome: "cancelled", turnId: "active" });
        if (source === "stop watchdog") {
          await stop();
          await vi.advanceTimersByTimeAsync(15_000);
        } else {
          gap("replay_failed");
          await vi.advanceTimersByTimeAsync(0);
        }
      }
      expect(await fact()).toMatchObject({
        state: "ended",
        outcome: source === "restarted engine" ? "failed" : "cancelled",
        steers: { [id]: "queued" },
      });
      expect(await follow).toContain(
        "ended without reading it; the product queued it as its own turn"
      );
      expect(await queue()).toMatchObject({ items: [{ id, state: "waiting" }] });
      end("active", "end_turn", []);
      expect(await fact()).toMatchObject({
        state: "ended",
        outcome: "done",
        steers: { [id]: "queued" },
      });
    }
  );

  it.each(["fresh steer", "promoted row"] as const)(
    "removes the recovered %s when its read arrives after the Stop watchdog",
    async (source) => {
      vi.useFakeTimers();
      await send("active");
      if (source === "fresh steer") await steer();
      else {
        await send("task");
        await steerRow("task");
      }
      const { input, origin } = engine.steerTurn.mock.lastCall![0];
      const id = lastSteerId();
      await send("later");
      await stopped("active");
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await fact()).toMatchObject({ state: "ended", steers: { [id]: "queued" } });
      expect(await ids()).toEqual([source === "fresh steer" ? id : "task", "later"]);

      echo("active", id, input, origin);
      expect(await fact()).toMatchObject({ state: "ended", steers: { [id]: "read" } });
      expect(await ids()).toEqual(["later"]);
      await resumeInWindow();
      expect(starts()).toEqual(["active", "later"]);
    }
  );

  it.each(["empty", "tail", "stop"] as const)(
    "withdraws a recovered steer's standalone send when its read arrives during app setup (%s)",
    async (next) => {
      const tail = next === "tail";
      vi.useFakeTimers();
      await send("active");
      await steer();
      const { steerId, input, origin } = engine.steerTurn.mock.lastCall![0];
      if (tail) await send("later");
      await stopped("active");
      await vi.advanceTimersByTimeAsync(15_000);

      const release = holdAppSetup();
      const resuming = resumeInWindow();
      expect((await queue()).items[0]).toMatchObject({ id: steerId, state: "sending" });
      echo("active", steerId, input, origin);
      const stopping = next === "stop" ? stop() : undefined;
      release();
      await Promise.all([resuming, stopping]);
      await vi.advanceTimersByTimeAsync(0);

      expect(starts()).toEqual(tail ? ["active", "later"] : ["active"]);
      expect(await queue()).toEqual({ paused: null, items: [] });
      expect(await run(api.session, { sessionId })).toMatchObject({
        status: tail ? "working" : "idle",
        error_message: null,
      });
      expect(await fact()).toMatchObject({ state: "ended", steers: { [steerId!]: "read" } });
      expect(await host.turn(caller, sessionId, steerId!)).toMatchObject(
        stopping
          ? { state: "ended", outcome: "cancelled", cancelledBy: fromPerson }
          : { state: "unknown" }
      );
    }
  );

  it("accepts one steer for the named turn, acknowledges retries and records a read from message.started alone", async () => {
    await send("active");
    expect(await fact()).toEqual({ state: "running", steers: {} });
    expect(await Promise.all([steer(), steer()])).toEqual([
      { outcome: "accepted" },
      { outcome: "accepted" },
    ]);
    expect(engine.steerTurn).toHaveBeenCalledExactlyOnceWith({
      sessionId,
      turnId: "active",
      steerId: "given",
      input: input.message,
      origin: fromChat,
    });
    expect(await ids()).toEqual(["given"]);
    await expect(steer({ message: "Different" })).rejects.toMatchObject({ name: "Refused" });
    const [started, ...parts] = echoFrames(
      "active",
      input.message,
      "given",
      fromChat,
      "opaque-message-id"
    );
    emit(started!);
    expect(await ids()).toEqual([]);
    expect(await fact()).toEqual({ state: "running", steers: { given: "read" } });
    for (const event of parts) emit(event);
    end("active");
    expect(await fact()).toEqual({ state: "ended", outcome: "done", steers: { given: "read" } });
    expect(await steer()).toEqual({ outcome: "accepted" });
    await expect(steer({ message: "Different after read" })).rejects.toMatchObject({
      name: "Refused",
    });
    await expect(
      host.steer!(caller, sessionId, { ...input, origin: fromAssistant })
    ).rejects.toMatchObject({ name: "Refused" });
    await expect(steer({ turnId: "successor" })).rejects.toMatchObject({ name: "Refused" });
    expect(engine.steerTurn).toHaveBeenCalledOnce();
    expect(starts()).toEqual(["active"]);
    const view = await host.view(caller, sessionId, { last: 1 });
    expect(view.lastEnded?.steers).toEqual({ given: "read" });
    expect(view.turns[0]).not.toHaveProperty("steers");
  });

  it("includes receipts when a view sees the end after the follow read a running turn", async () => {
    await send("active");
    await steer();
    await steer({ steerId: "unread" });
    expect(await fact()).toEqual({ state: "running", steers: {} });
    echo("active", "given", input.message, fromChat);
    end("active", "cancelled", ["unread"]);
    const view = await host.view(caller, sessionId, { last: 1 });
    expect(view.lastEnded).toMatchObject({
      turnId: "active",
      steers: { given: "read", unread: "queued" },
    });
    for (const turn of view.turns) expect(turn).not.toHaveProperty("steers");
  });

  it("uses the engine's admitted input for retries between a read and its first part", async () => {
    await send("active");
    await steer();
    const frames = echoFrames("active", input.message, "given", fromChat);
    for (const frame of frames) {
      emit(frame);
      if (frame.type !== "message.started") continue;
      engine.steerTurn.mockRejectedValueOnce(
        new WireRequestError(WIRE_ERROR_CODES.turnConflict, "different input")
      );
      await expect(steer({ message: "Different" })).rejects.toMatchObject({ name: "Refused" });
      expect(await steer()).toEqual({ outcome: "accepted" });
    }
    expect(await ids()).toEqual([]);
    expect(await fact()).toMatchObject({ steers: { given: "read" } });
  });

  it("removes a provisional steer when the engine refuses its id as a conflict", async () => {
    await send("active");
    engine.steerTurn.mockRejectedValueOnce(
      new WireRequestError(WIRE_ERROR_CODES.turnConflict, "different input")
    );
    await expect(steer()).rejects.toMatchObject({ name: "Refused" });
    end("active");
    expect(await ids()).toEqual([]);
    expect(starts()).toEqual(["active"]);
  });

  it("answers a lost steer as unconfirmed on retry and keeps the same row for its receipt", async () => {
    await send("active");
    engine.steerTurn.mockRejectedValueOnce(new Error("steer timed out"));
    const result = await sendFromChat("Review");
    expect(result).toMatch(/not confirmed/i);
    expect(engine.steerTurn).toHaveBeenCalledOnce();
    const { steerId, input, origin } = engine.steerTurn.mock.lastCall![0];
    expect(await ids()).toEqual([steerId]);
    echo("active", steerId, input, origin);
    expect(await ids()).toEqual([]);
  });

  it("keeps a steer behind an open question with its supplied id and sender", async () => {
    await send("active");
    question("active");
    expect(await steer()).toEqual({ outcome: "queued" });
    expect(await steer()).toEqual({ outcome: "queued" });
    expect((await queue()).items).toEqual([
      { id: "given", text: input.message, origin: fromChat, state: "waiting", images: 0 },
    ]);
    expect(engine.steerTurn).not.toHaveBeenCalled();
  });

  it.each(["no_active_turn", "unsupported"] as const)(
    "keeps the steer at the front after %s and converges after it runs",
    async (outcome) => {
      await sendInOrder("active", "later");
      engine.steerTurn.mockResolvedValueOnce({ outcome });
      expect(await steer()).toEqual({ outcome: "queued" });
      expect(await ids()).toEqual(["given", "later"]);
      expect(await steer()).toEqual({ outcome: "queued" });
      await expect(steer({ message: "different" })).rejects.toMatchObject({ name: "Refused" });
      end("active");
      await vi.waitFor(() => expect(starts()).toEqual(["active", "given"]));
      end("given");
      expect(await steer()).toEqual({ outcome: "queued" });
      await expect(steer({ message: "different" })).rejects.toMatchObject({ name: "Refused" });
      expect(starts().filter((id) => id === "given")).toHaveLength(1);
      expect(engine.steerTurn).toHaveBeenCalledOnce();
    }
  );

  it.each(["read", "queued"] as const)(
    "answers the caller and its joined retry from the %s receipt while the steer RPC is still pending",
    async (receipt) => {
      await send("active");
      const wire = pendingSteer();
      const answered = vi.fn();
      const calls = Promise.all([steer().then(answered), steer().then(answered)]);
      await vi.waitFor(() => expect(engine.steerTurn).toHaveBeenCalledOnce());
      if (receipt === "read") echo("active", "given", input.message, fromChat);
      else end("active", "end_turn", ["given"]);
      try {
        await vi.waitFor(() => expect(answered).toHaveBeenCalledTimes(2));
        expect(answered.mock.calls).toEqual(
          Array(2).fill([{ outcome: receipt === "read" ? "accepted" : "queued" }])
        );
        expect(await fact()).toMatchObject({
          state: receipt === "read" ? "running" : "ended",
          steers: { given: receipt },
        });
      } finally {
        wire.reject(new Error("late timeout"));
        await calls;
      }
      expect(engine.steerTurn).toHaveBeenCalledOnce();
      if (receipt === "queued") {
        expect(await steer()).toEqual({ outcome: "queued" });
        expect(starts()).toEqual(["active", "given"]);
      }
    }
  );

  it("starts the kept steer once when the named turn is already gone", async () => {
    expect(await steer()).toEqual({ outcome: "queued" });
    expect(await steer()).toEqual({ outcome: "queued" });
    expect(starts()).toEqual(["given"]);
    expect(engine.steerTurn).not.toHaveBeenCalled();
  });

  it("keeps a steer for a turn that ended while a different turn runs", async () => {
    await send("active");
    end("active");
    await send("successor");
    expect(await steer()).toEqual({ outcome: "queued" });
    expect(engine.steerTurn).not.toHaveBeenCalled();
    expect(await ids()).toEqual(["given"]);
    end("successor");
    await vi.waitFor(() => expect(starts()).toEqual(["active", "successor", "given"]));
  });

  it("queues behind an open question and runs the row only after the answered turn ends", async () => {
    await send("active");
    question("active");
    const reply = await sendFromChat("After the answer", "queue");
    expect(reply).toContain("position 1");
    expect(reply).toContain("Which branch?");
    expect(await run(api.session, { sessionId })).toMatchObject({ status: "needs_response" });
    const [row] = (await queue()).items;
    expect(row).toMatchObject({ state: "waiting", text: "After the answer" });
    expect(starts()).toEqual(["active"]);
    expect(answer(pendingFor(sessionId)[0]!.requestId, { result: { answers: ["main"] } })).toBe(
      true
    );
    emit({
      type: "elicitation.resolved",
      sessionId,
      turnId: "active",
      requestId: "question",
      outcome: { action: "accept", content: { q: "main" } },
      timestamp: seq,
    });
    await vi.waitFor(async () =>
      expect(await run(api.session, { sessionId })).toMatchObject({ status: "working" })
    );
    expect(await ids()).toEqual([row!.id]);
    expect(starts()).toEqual(["active"]);
    end("active");
    await vi.waitFor(() => expect(starts()).toEqual(["active", row!.id]));
    expect(await ids()).toEqual([]);
  });

  it("runs the agent's steer, its queued message and the person's send in arrival order after an empty Stop", async () => {
    await send("active");
    await stopped("active");
    await steer();
    await enqueue("queued");
    await send("person");
    expect(await ids()).toEqual(["given", "queued", "person"]);
    expect(engine.steerTurn).not.toHaveBeenCalled();
    end("active", "cancelled");
    await vi.waitFor(() => expect(wireTurnId()).toBe("given"));
    end("given");
    await vi.waitFor(() => expect(wireTurnId()).toBe("queued"));
    end("queued");
    await vi.waitFor(() => expect(starts()).toEqual(["active", "given", "queued", "person"]));
  });

  it("runs later person sends while both agent messages stay with an earlier held row", async () => {
    await sendInOrder("active", "held");
    await stopped("active");
    await steer();
    await enqueue("queued");
    await send("person");
    end("active", "cancelled");
    await vi.waitFor(() => expect(wireTurnId()).toBe("person"));
    await send("next");
    end("person");
    await vi.waitFor(() => expect(starts()).toEqual(["active", "person", "next"]));
    end("next");
    expect(await queue()).toMatchObject({ paused: "stopped", stoppedBy: fromPerson });
    expect(await ids()).toEqual(["given", "held", "queued"]);
    await resumeInWindow();
    expect(wireTurnId()).toBe("given");
  });

  it("gives one queue position for a repeated id and refuses different contents", async () => {
    await sendInOrder("active", "first");
    expect(await enqueue("next")).toEqual({ position: 2 });
    expect(await enqueue("next")).toEqual({ position: 2 });
    await enqueue("other", "Different");
    await expect(enqueue("next", "Different")).rejects.toMatchObject({ name: "Refused" });
    expect(await ids()).toEqual(["first", "next", "other"]);
  });

  it("commits an operator queue row before its drain waits on admission", async () => {
    const release = holdAppSetup();
    let position: number | undefined;
    const result = enqueue("next").then((reply) => {
      position = reply.position;
    });
    try {
      await vi.waitFor(() => expect(position).toBe(1));
      expect(await ids()).toEqual(["next"]);
    } finally {
      release();
      await result;
    }
    await vi.waitFor(() => expect(starts()).toEqual(["next"]));
  });

  it("omits the queue position once the same id has run", async () => {
    expect(await enqueue("next")).toEqual({ position: 1 });
    await vi.waitFor(() => expect(starts()).toEqual(["next"]));
    end("next");
    await enqueue("active");
    await vi.waitFor(() => expect(starts()).toEqual(["next", "active"]));
    await enqueue("other", "different");
    await enqueue("copy", "next");
    await expect(enqueue("next", "different")).rejects.toMatchObject({ name: "Refused" });
    expect(await enqueue("next")).toEqual({});
    expect(await ids()).toEqual(["other", "copy"]);
    expect(starts()).toEqual(["next", "active"]);
  });

  it("returns the waiting row's position for identical calls both during and after the first answer", async () => {
    await send("active");
    const operator = createOperator(host);
    const args = { session: sessionId, message: "Review", when: "queue", wait: 0 };
    const first = operator.call("send_message", args, caller);
    const second = operator.call("send_message", args, caller);
    const replies = await Promise.all([first, second]);
    expect(replies[1]).toContain(replies[0]);
    expect(replies[0]).toContain("(position 1)");
    expect(replies[0]).toContain("note: 1 message queued");
    const waiting = await ids();
    expect(waiting).toHaveLength(1);
    expect(await operator.call("send_message", args, caller)).toBe(replies[0]);
    expect(await ids()).toEqual(waiting);
  });

  it("matches a waiting row by sender and exact text, leaving unread steers and the person's sends distinct", async () => {
    await send("active");
    await steer();
    expect(await enqueue("other-row", input.message)).toEqual({ position: 2 });
    const assistant = {
      kind: "external",
      id: fromAssistant.id,
      speaksAs: "assistant",
      auth: LOCAL_CALLER,
    } as const;
    const fromReviewer = (turnId: string, name: string) =>
      host.queue!({ ...assistant, name }, sessionId, {
        turnId,
        message: input.message,
        origin: { ...fromAssistant, name },
      });
    expect(await fromReviewer("assistant", "Reviewer")).toEqual({ position: 3 });
    expect(await fromReviewer("second", "Renamed reviewer")).toEqual({ position: 3 });
    expect(await enqueue("another", input.message)).toEqual({ position: 2 });
    expect(await enqueue("different", input.message + "!")).toEqual({ position: 4 });
    for (const turnId of ["p1", "p2"])
      await host.queue!(windowCaller, sessionId, {
        turnId,
        message: input.message,
        origin: fromPerson,
      });
    expect(await ids()).toEqual(["given", "other-row", "assistant", "different", "p1", "p2"]);
  });

  it("coalesces at the queue write before charging a full agent queue", async () => {
    await send("active");
    for (let i = 0; i < 5; i++) await enqueue(String(i));
    await enqueueMessage({ ...message("duplicate"), turnId: "duplicate", content: "2" }, fromChat);
    expect(await ids()).toEqual(["0", "1", "2", "3", "4"]);
    expect(await enqueue("another", "2")).toEqual({ position: 3 });
  });

  it("adds a fresh queue request while the same sender's earlier row is sending", async () => {
    await send("active");
    await enqueue("head", input.message);
    engine.startTurn.mockResolvedValueOnce(undefined);
    end("active");
    await vi.waitFor(() => expect(starts()).toEqual(["active", "head"]));
    expect((await queue()).items[0]?.state).toBe("sending");
    expect(await enqueue("next", input.message)).toEqual({ position: 2 });
    expect(await ids()).toEqual(["head", "next"]);
  });

  it.each(["agents", "total"] as const)(
    "refuses both delivery methods in the queue's words at the %s cap",
    async (cap) => {
      await send("active");
      if (cap === "agents") for (let i = 0; i < 5; i++) await enqueue(String(i));
      else for (let i = 0; i < 20; i++) await send(String(i));
      const refusal = {
        name: "Refused",
        refusal: { code: "limit_resources", detail: new QueueLimitError(cap).message },
      };
      await expect(steer()).rejects.toMatchObject(refusal);
      await expect(enqueue("overflow")).rejects.toMatchObject(refusal);
      const operator = createOperator(host);
      for (const [when, verb] of [
        ["steer", "sent to"],
        ["queue", "queued for"],
      ] as const) {
        const send = operator.call(
          "send_message",
          { session: sessionId, message: "Full", when, wait: 0 },
          caller
        );
        await expect(send).rejects.toMatchObject({
          code: "limit_resources",
          message: expect.stringContaining(`Nothing was ${verb} "checkout:1".`),
        });
        await expect(send).rejects.toThrow(refusal.refusal.detail);
      }
      expect(engine.steerTurn).not.toHaveBeenCalled();
    }
  );

  it("leaves an operator queue request behind held rows while a plain send starts on a stopped chat", async () => {
    await send("active");
    await steer();
    await stopped("active");
    end("active", "cancelled", ["given"]);
    expect(await fact()).toEqual({
      state: "ended",
      outcome: "cancelled",
      cancelledBy: fromPerson,
      steers: { given: "queued" },
    });
    const note = "1 message queued, held: stopped by the person";
    expect((await host.list(caller, {})).find((e) => e.id === sessionId)?.note).toBe(note);
    expect((await host.view(caller, sessionId, { last: 1 })).note).toBe(note);
    const held = "2 messages queued, held: stopped by the person";
    expect(await sendFromChat("waiting", "queue")).toBe(
      `queued for "checkout:1" (position 2) in the product's queue.\nnote: ${held}`
    );
    expect(starts()).toEqual(["active"]);
    const answer = await sendFromChat("Different task");
    expect(answer).toContain("sent to");
    expect(answer).toContain(held);
    expect(starts()).toHaveLength(2);
    end(starts()[1]!);
    expect((await queue()).items).toMatchObject([{ id: "given" }, { text: "waiting" }]);
  });

  it("starts an idle chat's queued task with the turn id the operator supplied", async () => {
    const queued = vi.fn(host.queue!);
    const operator = createOperator({ ...host, queue: queued });
    const args = { session: sessionId, message: "Review", when: "queue", wait: 5 };
    const answer = operator.call("send_message", args, caller);
    await vi.waitFor(() => expect(starts()).toEqual([queued.mock.lastCall?.[2].turnId]));
    end(starts()[0]!);
    expect(await answer).toContain(
      `queued for "checkout:1" (position 1) in the product's queue; it started at once.\nstatus: done`
    );
  });
});

describe("operating another chat's queue", () => {
  const task = (id: string, origin: Origin = fromChat) =>
    enqueueMessage({ ...message(id), turnId: id }, origin);

  it("reads the order, states, senders, first lines and copyable ids", async () => {
    await send("active");
    const id = "opaque  id\n1";
    await enqueueMessage(
      { ...message("task"), turnId: id, content: 'Fix "x".\nSecond line' },
      fromChat
    );
    await send("person");
    db.prepare("INSERT INTO sessions (id, workspace_id, chat) VALUES ('peer', 'w', 3)").run();
    await task("sibling", { kind: "session", sessionId: "peer" });
    await steerMessage({ ...message("steer"), turnId: "active" }, fromAssistant);
    const read = await queueTool("read_queue");
    expect(read).toContain('1. steering · from "Reviewer"');
    expect(read).toContain(
      `2. waiting · from you · ${JSON.stringify('Fix "x".')} · message ${JSON.stringify(id)}`
    );
    expect(read).toContain("3. waiting · from the person");
    expect(read).toContain('4. waiting · from "checkout:3"');
    expect(read).not.toContain("Second line");
    expect(await queueTool("remove", id)).toBe(
      "Removed. 2 messages queued, 1 message being steered."
    );
    expect(await queueTool("remove", id)).toMatch(/no longer waiting/);
  });

  it("clips only the first line of each queue preview, keeping the id and hold whole", async () => {
    await send("active");
    const id = "opaque ".repeat(35).trimEnd();
    const edge = "a".repeat(159);
    await enqueueMessage(
      { ...message(id), turnId: id, content: edge + "🌴" + "x".repeat(50000) },
      fromChat
    );
    await enqueueMessage(
      { ...message("short"), turnId: "short", content: edge + "🌴\nsecond line" },
      fromAssistant
    );
    end("active", "error");
    const text = await queueTool("read_queue");
    expect(text).toContain(`"${edge}…" · message ${JSON.stringify(id)}`);
    expect(text).toContain(`"${edge}🌴" · message "short"`);
    expect(text).not.toContain("second line");
    expect(text).toMatch(/held after an error$/);
  });

  it("resolves a view's queue senders without opening unrelated workspace entries", async () => {
    db.exec(`
      INSERT INTO repositories (id, name, root_path) VALUES ('other-project', 'Other project', '/tmp/other');
      INSERT INTO workspaces (id, repository_id, slug, state) VALUES
        ('source','r','review','ready'), ('unrelated','other-project','other','ready');
      INSERT INTO sessions (id, workspace_id, chat) VALUES ('sibling','source',1), ('peer','source',3);
    `);
    await send("active");
    await task("row");
    await stopped("active", { kind: "session", sessionId: "peer" });
    end("active", "cancelled");
    const host = createDeusHost();
    const projected = vi.spyOn(chatTurns, "setupStop");
    try {
      expect((await host.view(windowCaller, sessionId, { last: 1 })).note).toContain(
        'stopped by "review:3"'
      );
      expect(new Set(projected.mock.calls.map(([id]) => id))).toEqual(new Set([sessionId]));
    } finally {
      projected.mockRestore();
    }
    db.prepare("UPDATE workspaces SET slug = 'REVIEW' WHERE id = 'unrelated'").run();
    const view = queueView(windowCaller, sessionId);
    expect(view.hold).toBe('held: stopped by "repo/review:3"');
    expect(view.senderName({ kind: "session", sessionId: "unrelated" })).toBe(
      "a chat that is gone"
    );
    expect(
      db.prepare("SELECT first_session_id FROM workspaces WHERE id = 'unrelated'").pluck().get()
    ).toBeNull();
  });

  it("uses the sender's current unambiguous reference for its rows and its Stop", async () => {
    db.exec(`
      INSERT INTO repositories (id, name, root_path) VALUES ('other', 'Other project', '/tmp/other');
      INSERT INTO workspaces (id, repository_id, slug, state)
        VALUES ('another', 'other', 'checkout', 'ready');
      INSERT INTO sessions (id, workspace_id, chat) VALUES ('peer', 'another', 2);
    `);
    const peer = { kind: "session", sessionId: "peer" } as const;
    await send("active");
    await task("one", peer);
    await task("two", { ...peer, name: "old:1" });
    await stopped("active", peer);
    end("active", "cancelled");
    const prepare = vi.spyOn(db, "prepare");
    const linked = await queueTool("read_queue");
    const globalLists = prepare.mock.calls.filter(
      ([sql]) => sql.includes("w.title AS ws_title") && /w.kind != 'cloud'\s+ORDER BY/.test(sql)
    );
    expect(globalLists).toHaveLength(1); // The package resolves the target once.
    prepare.mockRestore();
    expect(linked.match(/from "Other project\/checkout:2"/g)).toHaveLength(2);
    expect(linked).toContain('held: stopped by "Other project/checkout:2"');
    db.prepare("DELETE FROM sessions WHERE id = ?").run(peer.sessionId);
    const gone = await queueTool("read_queue");
    expect(gone.match(/from a chat that is gone/g)).toHaveLength(2);
    expect(gone).toContain("held: stopped by a chat that is gone");
  });

  it("shows the sending head until the turn echoes it", async () => {
    await send("active");
    await task("head");
    engine.startTurn.mockResolvedValueOnce(undefined);
    end("active");
    await vi.waitFor(() => expect(wireTurnId()).toBe("head"));
    expect(await queueTool("read_queue")).toContain('1. sending · from you · "Message head"');
    echo("head", undefined, "Message head", fromChat);
    expect(await queueTool("read_queue")).toContain("The queue is empty.");
  });

  it.each(["send_now", "remove"] as const)(
    "refuses %s on the person's and another agent's rows",
    async (action) => {
      await sendInOrder("active", "person");
      await task("assistant", fromAssistant);
      for (const id of ["person", "assistant"]) {
        expect(await queueTool(action, id)).toMatch(
          /refused \(not_yours\).*only its sender or the person can change it/i
        );
      }
      expect(await ids()).toEqual(["person", "assistant"]);
      expect(engine.steerTurn).not.toHaveBeenCalled();
    }
  );

  it("gives an external assistant its own rows and the person every row and their Stop", async () => {
    await send("active");
    await task("chat");
    await task("mine", { kind: "assistant", id: "assistant:reviewer", name: "Reviewer" });
    await task("theirs", fromAssistant);
    vi.spyOn(access, "currentHost").mockReturnValue(null);
    vi.spyOn(access, "storedAccess").mockReturnValue("operate");
    vi.spyOn(access, "assertMayWrite").mockImplementation(() => {});
    const manage = (caller: typeof LOCAL_CALLER, action: string, message?: string) =>
      callQueueMcp(caller, "manage_queue", { action, message });
    const assistant = assistantCaller("operate", "reviewer");
    for (const id of ["chat", "theirs"]) {
      expect(await manage(assistant, "remove", id)).toMatchObject({
        result: {
          isError: true,
          content: [
            { text: expect.stringContaining("Only its sender or the person can change it") },
          ],
        },
      });
    }
    await manage(assistant, "remove", "mine");
    expect(await ids()).toEqual(["chat", "theirs"]);
    await task("extra", fromAssistant);
    await manage(LOCAL_CALLER, "send_now", "extra");
    expect(engine.steerTurn.mock.lastCall?.[0].origin).toEqual(fromAssistant);
    echo("active", lastSteerId(), message("extra").content, fromAssistant);
    await manage(LOCAL_CALLER, "remove", "theirs");
    expect(await ids()).toEqual(["chat"]);
    await stopped("active");
    end("active", "cancelled");
    await send("successor");
    await stopped("successor", fromAssistant);
    end("successor", "cancelled");
    await resumeQueuedMessages(sessionId, fromAssistant);
    expect(await queue()).toMatchObject({ paused: "stopped", stoppedBy: fromPerson });
    await manage(LOCAL_CALLER, "resume");
    expect(starts()).toEqual(["active", "successor", "chat"]);
  });

  it("sends its own row into the named turn once", async () => {
    await send("active");
    await task("row");
    const sent = await queueTool("send_now", "row");
    expect(sent).toContain('Sent into turn "active"');
    expect(sent).toContain("not yet read");
    expect(sent).toContain("keeps its place");
    const { steerId, input, origin } = engine.steerTurn.mock.lastCall![0];
    expect(origin).toEqual(fromChat);
    echo("active", steerId, input, origin);
    expect(await queueTool("send_now", "row")).toMatch(/no longer waiting/);
    expect(engine.steerTurn).toHaveBeenCalledOnce();
    expect(await queueTool("resume")).toMatch(/nothing to resume/);
  });

  it("reports a read when the steer echo precedes the send_now answer", async () => {
    await send("active");
    await task("mine");
    engine.steerTurn.mockImplementationOnce(async ({ turnId, steerId, input, origin }) => {
      echo(turnId, steerId, input, origin);
      return { outcome: "steered", steerId: steerId! };
    });
    expect(await queueTool("send_now", "mine")).toBe('Read in turn "active".');
  });

  it("reports an unconfirmed send_now and keeps the row in place for a late read", async () => {
    await sendInOrder("active", "first");
    await task("mine");
    engine.steerTurn.mockRejectedValueOnce(new Error("timed out"));
    expect(await queueTool("send_now", "mine")).toMatch(/^Delivery unconfirmed\./i);
    expect((await queue()).items).toMatchObject([
      waitingRow("first"),
      { id: "mine", state: "steering" },
    ]);
    const { steerId, input, origin } = engine.steerTurn.mock.lastCall![0];
    echo("active", steerId, input, origin);
    expect(await ids()).toEqual(["first"]);
  });

  it("keeps a promoted row in place when its preceding row is removed before refusal", async () => {
    await sendInOrder("active", "X");
    await task("R");
    await send("Y");
    const rpc = pendingSteer();
    const result = queueTool("send_now", "R");
    await vi.waitFor(() => expect(engine.steerTurn).toHaveBeenCalledOnce());
    expect((await queue()).items.map(({ id, state }) => [id, state])).toEqual([
      ["X", "waiting"],
      ["R", "steering"],
      ["Y", "waiting"],
    ]);
    await remove("X");
    rpc.resolve({ outcome: "unsupported" });
    expect(await result).toMatch(/did not take it.*position 1/i);
    expect(await ids()).toEqual(["R", "Y"]);
    expect((await queue()).items[0]?.state).toBe("waiting");
  });

  it.each(["window arrow", "send_now"] as const)(
    "keeps the row in place during the RPC, then applies the %s fallback",
    async (source) => {
      await sendInOrder("active", "X");
      await task("R");
      await send("Y");
      const rpc = pendingSteer();
      const sending = source === "window arrow" ? steerRow("R") : queueTool("send_now", "R");
      await vi.waitFor(() => expect(engine.steerTurn).toHaveBeenCalledOnce());
      expect((await queue()).items).toMatchObject([
        { id: "X" },
        { id: "R", state: "steering" },
        { id: "Y" },
      ]);
      rpc.resolve({ outcome: "no_active_turn" });
      await sending;
      expect(await ids()).toEqual(source === "window arrow" ? ["R", "X", "Y"] : ["X", "R", "Y"]);
    }
  );

  it.each(["window arrow", "send_now"] as const)(
    "recovers an unread %s at its fallback position when the turn ends first",
    async (source) => {
      await sendInOrder("active", "X");
      await task("R");
      const rpc = pendingSteer();
      const sending = source === "window arrow" ? steerRow("R") : queueTool("send_now", "R");
      await vi.waitFor(() => expect(engine.steerTurn).toHaveBeenCalledOnce());
      end("active", "cancelled", [lastSteerId()]);
      rpc.resolve({ outcome: "steered", steerId: lastSteerId() });
      await sending;
      expect(await ids()).toEqual(source === "window arrow" ? ["R", "X"] : ["X", "R"]);
      expect(await queueTool("send_now", "R")).toContain("its own turn");
      expect(engine.steerTurn).toHaveBeenCalledOnce();
    }
  );

  it.each(["stopped", "question", "unsupported", "stale target", "unnamed"] as const)(
    "runs a fresh steer kept for a %s turn only as its own turn",
    async (why) => {
      await send("A");
      engine.cancelTurn.mockResolvedValueOnce({ outcome: "cancelled", turnId: "A" });
      if (why === "stopped") await stop();
      if (why === "question") question("A");
      if (why === "unsupported") engine.steerTurn.mockResolvedValueOnce({ outcome: "unsupported" });
      const turnId = why === "stale target" ? "old" : why === "unnamed" ? undefined : "A";
      await expect(steerMessage({ ...message("S"), turnId }, fromChat, "S")).resolves.toEqual({
        outcome: "queued",
      });
      if (why === "stopped") {
        end("A", "cancelled");
        await vi.waitFor(() => expect(starts()).toEqual(["A", "S"]));
        expect(engine.steerTurn).not.toHaveBeenCalled();
        return;
      }
      await stop();
      end("A", "cancelled");
      await send("B");
      await resumeInWindow();
      await send("later");
      expect(await queueTool("send_now", "S")).toContain("waits for its own turn in its place");
      expect(await ids()).toEqual(["S", "later"]);
      expect(engine.steerTurn.mock.calls.map(([p]) => p.turnId)).toEqual(
        why === "unsupported" ? ["A"] : []
      );
      end("B");
      await vi.waitFor(() => expect(starts()).toEqual(["A", "B", "S"]));
    }
  );

  it("keeps a second unread steer for its own turn after the first one starts", async () => {
    await send("first");
    await steerMessage({ ...message("one"), turnId: "first" }, fromChat, "one");
    await steerMessage({ ...message("two"), turnId: "first" }, fromChat, "two");
    end("first", "end_turn", ["one", "two"]);
    await vi.waitFor(() => expect(starts()).toEqual(["first", "one"]));
    await expect(
      steerMessage({ ...message("two"), turnId: "one" }, fromChat, "two")
    ).rejects.toThrow(/different message/i);
    expect(await queueTool("send_now", "two")).toMatch(/its own turn.*in (its|this) place/i);
    expect(engine.steerTurn).toHaveBeenCalledTimes(2);
    end("one");
    await vi.waitFor(() => expect(starts()).toEqual(["first", "one", "two"]));
  });

  it.each(["question", "plan"] as const)(
    "reports the %s that blocked the row's promotion",
    async (card) => {
      await sendInOrder("active", "first");
      await task("row");
      (card === "question" ? question : plan)("active");
      expect(await steerQueuedMessage(sessionId, "row", "active", "in_place")).toBe(card);
      expect(await queueTool("send_now", "row")).toContain(`Waiting behind the chat's ${card}`);
      expect(await ids()).toEqual(["first", "row"]);
    }
  );

  it("reports a row started as its own turn when the target has just gone idle", async () => {
    await send("active");
    await task("row");
    engine.steerTurn.mockImplementationOnce(async () => {
      emit({ type: "session.ended", sessionId, reason: "idle", timestamp: seq });
      db.prepare("UPDATE sessions SET status = 'idle' WHERE id = ?").run(sessionId);
      return { outcome: "no_active_turn" };
    });
    expect(await queueTool("send_now", "row")).toBe("Started as its own turn.");
    expect(starts()).toEqual(["active", "row"]);
  });

  it("keeps its row in place while held after an error, then resumes in order", async () => {
    await sendInOrder("active", "later");
    await task("mine");
    end("active", "error");
    expect(await queueTool("send_now", "mine")).toContain("held after an error");
    expect(await ids()).toEqual(["later", "mine"]);
    expect(starts()).toEqual(["active"]);
    expect(await queueTool("resume")).toBe('Resumed. Started turn "later". 1 message queued.');
    expect(starts()).toEqual(["active", "later"]);
  });

  it("send_now honors the person's Stop even after another turn starts", async () => {
    await sendInOrder("active", "first");
    await task("mine");
    await stopped("active");
    end("active", "cancelled");
    await send("successor");
    expect(await queueTool("send_now", "mine")).toContain("held: stopped by the person");
    expect(await ids()).toEqual(["first", "mine"]);
    expect(engine.steerTurn).not.toHaveBeenCalled();
  });

  it("send_now lets an idle open queue start its first waiting row", async () => {
    await sendInOrder("active", "first");
    await task("mine");
    emit({ type: "session.ended", sessionId, reason: "idle", timestamp: seq });
    db.prepare("UPDATE sessions SET status = 'idle' WHERE id = ?").run(sessionId);
    await queueTool("send_now", "mine");
    expect(starts()).toEqual(["active", "first"]);
    expect(await ids()).toEqual(["mine"]);
  });

  it("records who stopped an idle chat with waiting rows", async () => {
    await sendInOrder("active", "later");
    end("active", "error");
    engine.cancelTurn.mockResolvedValueOnce({ outcome: "no_active_turn" });
    await stopSession({ sessionId }, fromAssistant);
    expect(await queue()).toMatchObject({ paused: "stopped", stoppedBy: fromAssistant });
    expect(await queueTool("read_queue")).toContain('held: stopped by "Reviewer"');
  });

  it("keeps the first agent's Stop when a second agent stops a successor", async () => {
    await sendInOrder("A", "held");
    await stopped("A", fromChat);
    end("A", "cancelled");
    await send("B");
    await stopped("B", fromAssistant);
    end("B", "cancelled");
    expect((await queue()).stoppedBy).toEqual(fromChat);
    expect(await resumeQueuedMessages(sessionId, fromAssistant)).toMatchObject({ turnId: "held" });
  });

  it("records who stopped the chat during app setup", async () => {
    const release = holdAppSetup();
    const interrupted = expect(send("starting")).rejects.toThrow("Stopped before it started");
    await send("later");
    await stopSession({ sessionId }, fromChat);
    release();
    await interrupted;
    expect(await queue()).toMatchObject({
      paused: "stopped",
      stoppedBy: fromChat,
      items: [{ id: "later" }],
    });
  });

  it("starts a fresh send without Resume after an empty Stop during app setup", async () => {
    const releaseApps = holdAppSetup();
    const aborted = expect(send("A")).rejects.toThrow("Stopped before it started");
    await vi.waitFor(() => expect(resolveTurnApps).toHaveBeenCalled());
    expect(wireTurnId()).toBeUndefined();
    const stopping = stop();
    const fresh = send("R");
    await Promise.all([
      aborted,
      expect(stopping).resolves.toEqual({ unconfirmed: false }),
      expect(fresh).resolves.toEqual({ turnId: "R" }),
    ]);
    releaseApps();
    expect(await queue()).toEqual({ paused: null, items: [] });
    expect(starts()).toEqual(["R"]);
  });

  it.each([false, true])(
    "settles a Stop after a pending admission’s recorded end (row waiting: %s)",
    async (waiting) => {
      const admit = holdAdmission();
      const first = send("A");
      await vi.waitFor(() => expect(wireTurnId()).toBe("A"));
      if (waiting) await task("later");
      end("A", waiting ? "error" : "end_turn");
      const stopping = stop();
      admit();
      await Promise.all([first, stopping]);
      if (waiting) {
        expect(await queue()).toMatchObject({
          paused: "stopped",
          stoppedBy: fromPerson,
          items: [{ id: "later" }],
        });
        await remove("later");
      }
      expect(await queue()).toEqual({ paused: null, items: [] });
    }
  );

  it("keeps an agent's stop on the hold after the turn ends and lets another agent resume", async () => {
    await sendInOrder("active", "later");
    await stopped("active", fromChat);
    end("active", "cancelled");
    expect(await queue()).toMatchObject({ paused: "stopped", stoppedBy: fromChat });
    expect(await queueTool("read_queue")).toContain("held: stopped by you");
    expect(await queueTool("resume", undefined, "peer")).toBe(
      'Resumed. Started turn "later". Nothing waits.'
    );
  });

  it("gives the person's Stop precedence over an agent's on the same hold", async () => {
    await sendInOrder("active", "later");
    engine.cancelTurn.mockResolvedValue({ outcome: "cancelled", turnId: "active" });
    await stopSession({ sessionId }, fromChat);
    await stop();
    await stopSession({ sessionId }, fromAssistant);
    end("active", "cancelled");
    expect(await queue()).toMatchObject({ paused: "stopped", stoppedBy: fromPerson });
    expect(await queueTool("read_queue")).toContain("held: stopped by the person");
    expect(await queueTool("resume")).toContain(
      "refused (person_only): Nothing was resumed. The queue is held: stopped by the person."
    );
    expect(starts()).toEqual(["active"]);
  });

  it("releases the hold when its last row is removed while the turn is still ending", async () => {
    await sendInOrder("active", "last");
    await stopped("active");
    await remove("last");
    expect(await queue()).toEqual({ paused: null, items: [] });
    await task("later");
    end("active", "cancelled");
    await vi.waitFor(() => expect(starts()).toEqual(["active", "later"]));
  });

  it("runs unheld sends in arrival order after a held row is dragged above the first", async () => {
    await sendInOrder("A", "held");
    await stopped("A");
    await send("later");
    expect(await ids()).toEqual(["later", "held"]);
    expect(await move("held", "later")).toEqual({ moved: true });
    await send("last");
    expect(await ids()).toEqual(["held", "later", "last"]);
    engine.startTurn.mockResolvedValueOnce(undefined);
    end("A", "cancelled");
    await vi.waitFor(() => expect(starts()).toEqual(["A", "later"]));
    expect((await queue()).items).toMatchObject([
      { id: "later", state: "sending" },
      waitingRow("held"),
      waitingRow("last"),
    ]);
    const [started, ...parts] = echoFrames("later", message("later").content);
    emit(started!);
    expect(await queueTool("read_queue")).toContain(
      '1. sending · from the person · "Message later"'
    );
    for (const frame of parts) emit(frame);
    expect(await ids()).toEqual(["held", "last"]);
    end("later");
    await vi.waitFor(() => expect(starts()).toEqual(["A", "later", "last"]));
    expect(await queue()).toMatchObject({ paused: "stopped", items: [waitingRow("held")] });
  });

  it.each(["operator send", "remove head", "resume head"] as const)(
    "settles the Stop on a busy start (%s)",
    async (source) => {
      const wire = Promise.withResolvers<void>();
      let refused: Promise<unknown> | undefined;
      if (source === "operator send") {
        engine.startTurn.mockReturnValueOnce(wire.promise);
        refused = expect(
          createDeusHost().send(chatCaller, sessionId, {
            turnId: "B",
            message: "Message B",
            origin: fromChat,
          })
        ).rejects.toMatchObject({ refusal: { code: "busy" } });
      } else {
        await sendInOrder("A", "B");
        engine.startTurn.mockReturnValueOnce(wire.promise);
        end("A");
      }
      await vi.waitFor(() => expect(starts().at(-1)).toBe("B"));
      const stopping = stop();
      wire.reject(busyReply());
      await Promise.all([stopping, refused]);
      if (source !== "operator send") {
        expect(await queue()).toMatchObject({
          paused: "stopped",
          items: [waitingRow("B")],
        });
        if (source === "remove head") await remove("B");
        else {
          await agent.startTurn(sessionId, "winner", "codex-app-server", "competing turn", {
            cwd: "/tmp/repo",
          });
          end("winner");
          await resumeInWindow();
          expect(starts()).toEqual(["A", "B", "winner", "B"]);
        }
      }
      expect(await queue()).toEqual({ paused: null, items: [] });
    }
  );

  it("steers an agent’s fresh message into the person’s successor and keeps the earlier Stop if it fails", async () => {
    await send("active");
    await task("agent-row");
    await stopped("active");
    end("active", "cancelled");
    await sendInOrder("successor", "person-row");
    await expect(
      steerMessage({ ...message("steer"), turnId: "successor" }, fromChat, "steer")
    ).resolves.toEqual({ outcome: "steered" });
    echo("successor", "steer", message("steer").content, fromChat);
    end("successor", "error");
    expect(await ids()).toEqual(["person-row", "agent-row"]);
    expect(await queueTool("resume")).toMatch(/refused \(person_only\)/);
    expect(starts()).toEqual(["active", "successor"]);
    await resumeInWindow();
    expect(starts()).toEqual(["active", "successor", "person-row"]);
  });

  it.each(["Stop", "failure", "cancel"] as const)(
    "forgets an empty settled %s and starts the next row",
    async (cause) => {
      await send("active");
      if (cause !== "cancel") await task("one");
      if (cause === "Stop") await stopped("active");
      end("active", cause === "failure" ? "error" : "cancelled");
      if (cause === "failure") expect((await queue()).paused).toBe("failed");
      if (cause !== "cancel") expect(await remove("one")).toEqual({ removed: true });
      expect(await queue()).toEqual({ paused: null, items: [] });
      await task("two", fromAssistant);
      await vi.waitFor(() => expect(starts()).toEqual(["active", "two"]));
    }
  );

  it("turns a failed hold into a person-only Stop on the same turn's cancelled end", async () => {
    await send("active");
    await task("later");
    engine.cancelTurn.mockResolvedValueOnce({ outcome: "no_active_turn", activeTurnId: "other" });
    gap("replay_failed");
    await vi.waitFor(async () => expect((await queue()).paused).toBe("failed"));
    expect((await queue()).paused).toBe("failed");
    end("active", "cancelled");
    expect(await queue()).toMatchObject({ paused: "stopped", items: [{ id: "later" }] });
    expect(await queue()).not.toHaveProperty("stoppedBy");
    expect(await resumeQueuedMessages(sessionId, fromAssistant)).toEqual({
      outcome: "person_only",
    });
  });

  it.each([true, false])(
    "keeps a lost start reply's queue until the live turn ends or the failure is resumed (turn.started: %s)",
    async (started) => {
      await loseStartReply(started);
      expect(wireTurnId()).toBe(started ? "A" : undefined);
      expect(await queue()).toMatchObject({ paused: started ? null : "failed" });
      expect(await run(api.session, { sessionId })).toMatchObject({
        status: started ? "working" : "error",
      });
      const { status, error_message, error_category } = (await run(api.session, { sessionId }))!;
      if (!started) engine.startTurn.mockRejectedValueOnce(busyReply());
      await resumeInWindow();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(starts()).toEqual(started ? ["A"] : ["A", "R"]);
      expect(await run(api.session, { sessionId })).toMatchObject({
        status,
        error_message,
        error_category,
      });
      expect(await queue()).toMatchObject({ paused: null, items: [waitingRow("R")] });
      if (started) {
        end("A");
        await vi.waitFor(() => expect(starts()).toEqual(["A", "R"]));
        expect(await ids()).toEqual([]);
      }
    }
  );

  it.each(["end_turn", "error", "server_restarted"] as const)(
    "answers later Resumes as open and drains when the interrupted turn settles with %s",
    async (reason) => {
      await failLiveReplay();
      expect(await resumeQueuedMessages(sessionId, fromChat)).toMatchObject({ outcome: "resumed" });
      expect(await resumeQueuedMessages(sessionId, fromAssistant)).toEqual({ outcome: "open" });
      expect(await resumeQueuedMessages(sessionId)).toEqual({ outcome: "open" });
      expect(starts()).toEqual(["A"]);
      if (reason === "server_restarted") gap(reason);
      else end("A", reason);
      await vi.waitFor(() => expect(starts()).toEqual(["A", "R"]));
      expect(await queue()).toEqual({ paused: null, items: [] });
    }
  );

  it.each(["native terminal", "unconfirmed replay cancel"] as const)(
    "keeps the agent's Resume in force when the live turn is cancelled (%s)",
    async (cancel) => {
      await failLiveReplay();
      expect(await resumeQueuedMessages(sessionId, fromChat)).toMatchObject({ outcome: "resumed" });
      if (cancel === "unconfirmed replay cancel") {
        engine.cancelTurn.mockResolvedValueOnce({ outcome: "unconfirmed", turnId: "A" });
        gap("replay_failed");
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      end("A", "cancelled");
      await vi.waitFor(() => expect(starts()).toEqual(["A", "R"]));
    }
  );

  it("queues a steer into a turn that already reported a failure", async () => {
    await failLiveReplay();
    await steer("follow-up");
    expect(engine.steerTurn).not.toHaveBeenCalled();
    const [id] = await ids();
    end("A", "error");
    await vi.waitFor(() => expect(starts()).toEqual(["A", id]));
    expect(await ids()).toEqual(["R"]);
  });

  it.each(["failure", "cancelled"] as const)(
    "runs messages arriving after a live %s on an empty queue",
    async (cause) => {
      await send("A");
      engine.cancelTurn.mockResolvedValueOnce(
        cause === "failure"
          ? { outcome: "no_active_turn", activeTurnId: "other" }
          : { outcome: "unconfirmed", turnId: "A" }
      );
      gap("replay_failed");
      await vi.waitFor(async () =>
        expect(await run(api.session, { sessionId })).toMatchObject({ error_category: "network" })
      );
      await task("agent");
      await send("person");
      end("A", cause === "failure" ? "error" : "cancelled");
      await vi.waitFor(() => expect(wireTurnId()).toBe("agent"));
      end("agent");
      await vi.waitFor(() => expect(starts()).toEqual(["A", "agent", "person"]));
    }
  );

  it("queues a steer aimed at the stopped turn after the person's Resume until that turn ends", async () => {
    await sendInOrder("T", "waiting");
    await stopped("T");
    await resumeInWindow();
    expect(wireTurnId()).toBe("T");
    await steer("follow-up");
    const [next] = (await queue()).items;
    expect(next).toMatchObject({ state: "waiting", text: "Message follow-up" });
    expect(engine.steerTurn).not.toHaveBeenCalled();
    end("T", "cancelled");
    await vi.waitFor(() => expect(starts()).toEqual(["T", next!.id]));
  });

  it("honors an agent's Resume of an attributed Stop while its turn is still ending", async () => {
    await sendInOrder("A", "R");
    await stopped("A", fromChat);
    expect(await resumeQueuedMessages(sessionId, fromAssistant)).toMatchObject({
      outcome: "resumed",
    });
    end("A", "cancelled");
    await vi.waitFor(() => expect(starts()).toEqual(["A", "R"]));
    expect((await queue()).paused).toBeNull();
  });

  it("retries a resumed turn’s unechoed head when it ends", async () => {
    await sendInOrder("A", "head", "tail");
    engine.startTurn.mockResolvedValueOnce(undefined);
    end("A");
    await vi.waitFor(() => expect(starts()).toEqual(["A", "head"]));
    await stopped("head");
    await resumeInWindow();
    end("head");
    await vi.waitFor(() => expect(starts()).toHaveLength(3));
    expect(engine.startTurn.mock.lastCall![0].input).toBe("Message head");
    expect(await ids()).toEqual(["tail"]);
  });

  it.each(["cancelled", "unconfirmed"] as const)(
    "keeps replay cancellation for the person when the RPC answers %s before the terminal",
    async (outcome) => {
      await send("active");
      await task("later");
      engine.cancelTurn.mockResolvedValueOnce({ outcome, turnId: "active" });
      gap("replay_failed");
      await vi.waitFor(async () => expect((await queue()).paused).toBe("stopped"));
      expect(await queueTool("resume")).toMatch(/refused \(person_only\)/);
      expect(wireTurnId()).toBe(outcome === "unconfirmed" ? "active" : undefined);
      end("active", "cancelled");
      expect(await queue()).toMatchObject({ paused: "stopped", items: [{ id: "later" }] });
      expect(await queue()).not.toHaveProperty("stoppedBy");
      expect(await queueTool("resume")).toMatch(/refused \(person_only\)/);
      expect(starts()).toEqual(["active"]);
    }
  );

  it("settles a failed replay as a failure when the engine confirms that no turn is active", async () => {
    await send("active");
    await task("later");
    engine.cancelTurn.mockResolvedValueOnce({ outcome: "no_active_turn" });
    gap("replay_failed");
    await vi.waitFor(async () => expect((await queue()).paused).toBe("failed"));
    expect(wireTurnId()).toBeUndefined();
    expect(await queueTool("resume")).toContain('Started turn "later"');
    expect(starts()).toEqual(["active", "later"]);
  });

  it.each(["person", "agent"] as const)(
    "applies a successor's unconfirmed replay cancel under a %s Stop",
    async (who) => {
      await send("A");
      await task("later");
      await stopped("A", who === "person" ? fromPerson : fromChat);
      end("A", "cancelled");
      await send("B");
      engine.cancelTurn.mockResolvedValueOnce({ outcome: "unconfirmed", turnId: "B" });
      gap("replay_failed");
      await vi.waitFor(async () =>
        expect(await run(api.session, { sessionId })).toMatchObject({ error_category: "network" })
      );
      expect(wireTurnId()).toBe("B");
      await steer("aimed at B");
      expect(engine.steerTurn).not.toHaveBeenCalled();
      expect(await queueTool("resume")).toMatch(/refused \(person_only\)/);
      if (who === "person") expect((await queue()).stoppedBy).toEqual(fromPerson);
      else expect(await queue()).not.toHaveProperty("stoppedBy");
      await resumeInWindow();
      await steer("after Resume");
      const [{ id, text }] = (await queue()).items;
      expect(text).toBe("Message after Resume");
      expect(engine.steerTurn).not.toHaveBeenCalled();
      end("B", "cancelled");
      await vi.waitFor(() => expect(starts()).toEqual(["A", "B", id]));
      expect((await queue()).paused).toBeNull();
    }
  );

  it("keeps a successor's failure open to an agent's Resume when an older cancel replays", async () => {
    await send("A");
    end("A");
    await sendInOrder("B", "R");
    end("B", "error");
    const held = await queue();
    expect(held).toMatchObject({ paused: "failed", items: [waitingRow("R")] });
    end("A", "cancelled");
    expect(await queue()).toEqual(held);
    expect(await resumeQueuedMessages(sessionId, fromChat)).toMatchObject({ outcome: "resumed" });
    expect(starts()).toEqual(["A", "B", "R"]);
  });

  it.each(["agent Stop", "failure"] as const)(
    "a successor’s independent cancel replaces an earlier %s",
    async (prior) => {
      await send("A");
      await task("later");
      if (prior === "agent Stop") await stopped("A", fromChat);
      end("A", prior === "failure" ? "error" : "cancelled");
      await send("B");
      const held = await queue();
      end("A");
      expect(await queue()).toEqual(held);
      end("B", "cancelled");
      expect(await queue()).toMatchObject({ paused: "stopped", items: [{ id: "later" }] });
      expect(await queue()).not.toHaveProperty("stoppedBy");
      expect(await queueTool("resume")).toMatch(/refused \(person_only\)/);
      expect(starts()).toEqual(["A", "B"]);
    }
  );

  it("keeps the actual Stop on the same turn through its replay cancellation and terminal", async () => {
    await send("A");
    await task("later");
    engine.cancelTurn.mockResolvedValue({ outcome: "unconfirmed", turnId: "A" });
    await stopSession({ sessionId }, fromAssistant);
    gap("replay_failed");
    await vi.waitFor(async () =>
      expect(await run(api.session, { sessionId })).toMatchObject({ error_category: "network" })
    );
    expect((await queue()).stoppedBy).toEqual(fromAssistant);
    end("A", "cancelled");
    expect((await queue()).stoppedBy).toEqual(fromAssistant);
    expect(await queueTool("resume")).toContain('Started turn "later"');
  });

  it.each(["confirmed absence", "rejected start"] as const)(
    "releases an empty settled failure after %s, without another terminal",
    async (cause) => {
      await send("A");
      await task("later");
      if (cause === "confirmed absence") {
        engine.cancelTurn.mockResolvedValueOnce({ outcome: "no_active_turn" });
        gap("replay_failed");
      } else {
        engine.startTurn.mockRejectedValueOnce(
          new WireRequestError(WIRE_ERROR_CODES.shuttingDown, "shutting down")
        );
        end("A");
      }
      await vi.waitFor(async () => expect((await queue()).paused).toBe("failed"));
      expect(wireTurnId()).toBeUndefined();
      expect(await remove("later")).toEqual({ removed: true });
      expect(await queue()).toEqual({ paused: null, items: [] });
      await send("B");
      await task("next");
      end("B");
      await vi.waitFor(() => expect(starts().at(-1)).toBe("next"));
    }
  );

  it("leaves a cancellation without a Stop for the person to resume", async () => {
    await send("active");
    await task("later");
    // Replay recovery cancels the engine directly. Its terminal can beat the cancel reply.
    engine.cancelTurn.mockImplementationOnce(async () => {
      end("active", "cancelled");
      return { outcome: "cancelled", turnId: "active" };
    });
    gap("replay_failed");
    await resumeQueuedMessages(sessionId, fromAssistant);
    const hold = "held: stopped without a recorded Stop; only the person can resume it";
    expect(await queue()).not.toHaveProperty("stoppedBy");
    expect(await queueTool("read_queue")).toContain(hold);
    engine.cancelTurn.mockResolvedValueOnce({ outcome: "no_active_turn" });
    await stopSession({ sessionId }, fromChat);
    expect(await queueTool("resume")).toContain(
      `refused (person_only): Nothing was resumed. The queue is ${hold}.`
    );
    expect(starts()).toEqual(["active"]);
    await resumeInWindow();
    expect(starts()).toEqual(["active", "later"]);
  });

  it.each(["read_queue", "resume"] as const)(
    "refuses the chat's own queue (%s)",
    async (action) => {
      expect(await queueTool(action, undefined, sessionId)).toMatch(/refused \(self\)/);
    }
  );

  it("allows only read_queue in plan mode and with read-only assistant access", async () => {
    expect(await queueTool("read_queue", undefined, "lead", "plan")).toContain("queue is empty");
    expect(await queueTool("resume", undefined, "lead", "plan")).toContain("refused (read_only)");
    vi.spyOn(access, "currentHost").mockReturnValue(null);
    vi.spyOn(access, "storedAccess").mockReturnValue("read");
    const call = (name: string, args: Record<string, unknown>) =>
      callQueueMcp(assistantCaller("read"), name, args);
    expect(await call("read_queue", {})).toMatchObject({
      result: { content: [{ text: expect.stringContaining("queue is empty") }] },
    });
    expect(await call("manage_queue", { action: "resume" })).toMatchObject({
      result: { isError: true, content: [{ text: expect.stringContaining("refused (access)") }] },
    });
  });
});

describe("continuing a chat after a usage limit", () => {
  const minute = 60_000;
  const now = Date.UTC(2026, 10, 24, 3);
  const resetsAt = now + 2 * minute;
  const caller = windowCaller;
  const choose = (on: boolean) => run(api.continueAfterLimit, { sessionId, on });
  const preference = (on: boolean) =>
    vi
      .spyOn(settings, "getSetting")
      .mockImplementation((key) => key === "continue_after_usage_limit" && on);
  function windows(windows: SessionLimitsEvent["windows"], status?: SessionLimitsEvent["status"]) {
    emit({
      type: "session.limits",
      sessionId,
      turnId: wireTurnId()!,
      windows,
      status,
      timestamp: seq,
    });
  }
  function fail(category = "usage_limit", message = "Provider refused this turn") {
    const turnId = wireTurnId()!;
    const { harness, model, thinkingLevel, permissionMode } =
      engine.startTurn.mock.lastCall![0].config;
    const error = { category, message };
    emit({ type: "error", sessionId, turnId, ...error, recoverable: false, timestamp: seq });
    emit({
      type: "turn.ended",
      sessionId,
      turnId,
      stopReason: "error",
      error,
      timestamp: seq,
      execution: { harness, model, thinkingLevel, permissionMode },
    });
  }
  async function limited(reset = resetsAt) {
    await send("A");
    windows([{ id: "primary", usedPercent: 100, resetsAt: reset }], "limited");
    fail();
  }
  beforeEach(() => vi.useFakeTimers({ now }));
  afterEach(() => vi.restoreAllMocks());

  it.each([false, true])(
    "refuses an agent's resume before the reset and reports automatic continuation (%s)",
    async (on) => {
      await limited();
      await choose(on);
      await resumeQueuedMessages(sessionId, fromAssistant);
      expect((await queue()).paused).toBe("limit");
      const text = await queueTool("resume");
      expect(text).toContain("refused (busy)");
      expect(text).toContain("resets 2026-11-24 03:02 UTC");
      expect(text).toContain(on ? "continues by itself" : "automatic continuation is off");
      expect(text).toContain("Nothing waits.");
      expect(await queueTool("read_queue")).toContain("held: stopped on a usage limit");
      expect((await queue()).paused).toBe("limit");
    }
  );

  it.each([false, true])(
    "resumes after the reset with only a waiting message (row %s)",
    async (hasRow) => {
      await send("active");
      if (hasRow) await send("later");
      windows([{ id: "primary", usedPercent: 100, resetsAt }], "limited");
      fail();
      await choose(true);
      vi.setSystemTime(resetsAt + 1);
      expect(await queueTool("resume")).toContain(
        hasRow ? 'Started turn "later"' : "Nothing waits."
      );
      await vi.advanceTimersByTimeAsync(2 * minute);
      expect(starts()).toEqual(hasRow ? ["active", "later"] : ["active"]);
    }
  );

  it("leaves a usage limit without a reset time to the person", async () => {
    await send("active");
    fail();
    await resumeQueuedMessages(sessionId, fromChat);
    expect((await queue()).paused).toBe("limit");
    expect(await queueTool("resume")).toContain(
      "refused (person_only): Nothing was resumed. The queue is held: stopped on a usage limit, no reset time was reported, the person decides"
    );
    expect((await queue()).paused).toBe("limit");
    expect(starts()).toEqual(["active"]);
  });

  it("uses the latest rejected Claude window reported during the failing turn", async () => {
    const claude = (id: string) =>
      run(api.sendMessage, { ...message(id), turnId: id, agentHarness: "claude-code" });
    await claude("older");
    windows([{ id: "seven_day_sonnet", status: "limited", resetsAt: resetsAt + 60 * minute }]);
    end("older");
    await claude("A");
    windows([{ id: "week", status: "limited", resetsAt: resetsAt + minute }]);
    windows([
      { id: "five_hour", status: "limited", resetsAt },
      { id: "warning", status: "warning", usedPercent: 100, resetsAt: resetsAt + 2 * minute },
      { id: "expires", status: "limited", resetsAt: now },
      { id: "ok", status: "ok", usedPercent: 100, resetsAt: resetsAt + 3 * minute },
    ]);
    fail();
    expect(await queue()).toEqual({
      items: [],
      paused: "limit",
      limit: { resetsAt: resetsAt + minute, continues: false },
    });
    await vi.advanceTimersByTimeAsync(10 * minute);
    expect(starts()).toEqual(["older", "A"]);
  });

  it("keeps the time unknown when only the previous turn reported a limit", async () => {
    preference(true);
    await send("A");
    windows([{ id: "five_hour", usedPercent: 100, resetsAt }], "limited");
    end("A");
    await send("B");
    emit({
      type: "session.limits",
      sessionId,
      turnId: "A",
      timestamp: seq,
      status: "limited",
      windows: [{ id: "seven_day", usedPercent: 100, resetsAt: resetsAt + minute }],
    });
    fail();
    expect((await queue()).limit).toEqual({ continues: false });
    await vi.advanceTimersByTimeAsync(5 * minute);
    expect(starts()).toEqual(["A", "B"]);
  });

  it.each([false, true])(
    "uses each Codex pool's own report status (reversed %s)",
    async (reverse) => {
      await send("A");
      const reports = [
        () => windows([{ id: "five_hour", usedPercent: 100, resetsAt }], "limited"),
        () => windows([{ id: "spark:five_hour", usedPercent: 100, resetsAt: resetsAt + minute }]),
      ];
      for (const report of reverse ? reports.reverse() : reports) report();
      fail();
      expect((await queue()).limit).toEqual({ resetsAt, continues: false });
    }
  );

  it("drops a window that recovered or expired before the turn failed", async () => {
    preference(true);
    await send("A");
    windows([
      { id: "five_hour", status: "limited", resetsAt },
      { id: "seven_day", status: "limited", resetsAt: resetsAt + minute },
    ]);
    windows([{ id: "seven_day", status: "ok" }]);
    vi.setSystemTime(resetsAt);
    fail();
    expect((await queue()).limit).toEqual({ continues: false });
  });

  it.each(["empty", "expired", "partial", "available"] as const)(
    "keeps a limit with no known reset (%s)",
    async (report) => {
      preference(true);
      await run(api.sendMessage, {
        ...message("A"),
        turnId: "A",
        agentHarness: report === "empty" ? "gemini" : "codex-app-server",
      });
      if (report !== "empty")
        windows(
          [
            {
              id: "primary",
              usedPercent: report === "partial" ? 99 : 100,
              resetsAt: report === "expired" ? now - 1 : resetsAt,
            },
          ],
          report === "available" ? "ok" : "limited"
        );
      fail();
      expect(await queue()).toEqual({ items: [], paused: "limit", limit: { continues: false } });
      await expect(choose(true)).rejects.toThrow(/reset time/i);
      await vi.advanceTimersByTimeAsync(10 * minute);
      expect(starts()).toEqual(["A"]);
    }
  );

  it.each([false, true])(
    "a press at the reset continues immediately once (queued row %s)",
    async (hasRow) => {
      await send("A");
      if (hasRow) await send("head");
      windows([{ id: "primary", usedPercent: 100, resetsAt }], "limited");
      fail();
      if (hasRow) await choose(true);
      await vi.advanceTimersByTimeAsync(resetsAt - now);
      expect(starts()).toEqual(["A"]);
      await choose(true);
      expect(engine.startTurn.mock.lastCall![0].input).toBe(hasRow ? "Message head" : "Continue.");
      await vi.advanceTimersByTimeAsync(2 * minute);
      expect(starts()).toHaveLength(2);
    }
  );

  it("sends the head with its own settings once, a minute after the reset", async () => {
    await sendInOrder("A", "head", "tail");
    windows(
      [
        { id: "primary", usedPercent: 100, resetsAt: resetsAt + 17_321 },
        { id: "secondary", usedPercent: 35, resetsAt: resetsAt + minute },
      ],
      "limited"
    );
    fail();
    await choose(true);
    await choose(true);
    expect((await queue()).limit).toEqual({ resetsAt: resetsAt + 17_321, continues: true });
    await vi.advanceTimersByTimeAsync(3 * minute + 17_320);
    expect(starts()).toEqual(["A"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts()).toEqual(["A", "head"]);
    expect(engine.startTurn.mock.lastCall![0]).toMatchObject({
      input: "Message head",
      config: { model: "model-head" },
    });
    await vi.advanceTimersByTimeAsync(10 * minute);
    expect(starts()).toEqual(["A", "head"]);
    end("head");
    await vi.advanceTimersByTimeAsync(0);
    expect(starts()).toEqual(["A", "head", "tail"]);
  });

  it("sends Continue with the latest turn's model, thinking level and permission mode", async () => {
    await run(api.sendMessage, {
      ...message("old"),
      turnId: "z-first",
      thinkingLevel: "low",
      permissionMode: "bypass_permissions",
    });
    fail("rate_limit");
    await run(api.sendMessage, {
      ...message("new"),
      turnId: "a-last",
      thinkingLevel: "high",
      permissionMode: "plan",
    });
    windows([{ id: "primary", usedPercent: 100, resetsAt }], "limited");
    fail();
    await choose(true);
    await vi.advanceTimersByTimeAsync(3 * minute);
    expect(engine.startTurn.mock.lastCall![0]).toMatchObject({
      input: "Continue.",
      config: { model: "model-new", thinkingLevel: "high", permissionMode: "plan" },
    });
  });

  it("continues a rejected account window once even when the model was also refused", async () => {
    preference(true);
    await run(api.sendMessage, {
      ...message("A"),
      agentHarness: "claude-code",
      model: "fable",
      thinkingLevel: "high",
      permissionMode: "plan",
    });
    windows([{ id: "five_hour", status: "limited", resetsAt }]);
    const modelRefusal = "You've reached your Fable limit. Switch to another model.";
    fail("usage_limit", modelRefusal);
    expect((await queue()).limit).toEqual({ resetsAt, continues: true });
    vi.setSystemTime(resetsAt + 8 * 60 * minute);
    await vi.advanceTimersByTimeAsync(minute);
    expect(engine.startTurn.mock.lastCall![0]).toMatchObject({
      input: "Continue.",
      config: {
        harness: "claude-code",
        model: "fable",
        thinkingLevel: "high",
        permissionMode: "plan",
      },
    });
    fail("rate_limit", modelRefusal);
    await vi.advanceTimersByTimeAsync(24 * 60 * minute);
    expect(starts()).toHaveLength(2);
    expect((await queue()).limit).toBeUndefined();
    expect(await run(api.session, { sessionId })).toMatchObject({
      status: "error",
      error_category: "rate_limit",
      error_message: modelRefusal,
    });
  });

  it.each([false, true])(
    "a second limit starts from the preference (%s), not the previous choice",
    async (on) => {
      preference(!on);
      await limited();
      await choose(true);
      preference(on);
      await vi.advanceTimersByTimeAsync(3 * minute);
      windows([{ id: "primary", usedPercent: 100, resetsAt: now + 4 * minute }], "limited");
      fail();
      expect((await queue()).limit).toEqual({ resetsAt: now + 4 * minute, continues: on });
      await vi.advanceTimersByTimeAsync(3 * minute);
      expect(starts()).toHaveLength(on ? 3 : 2);
    }
  );

  it.each(["cancel", "person", "operator", "resume", "stop", "archive", "hide", "delete"] as const)(
    "clears the scheduled attempt on %s",
    async (action) => {
      preference(true);
      await limited();
      expect((await queue()).limit?.continues).toBe(true);
      if (action === "person") await send("B");
      if (action === "operator")
        await createDeusHost().send(caller, sessionId, {
          turnId: "B",
          origin: { kind: "session", sessionId: "lead" },
          message: "Manual follow-up",
        });
      if (action === "person" || action === "operator") end("B");
      if (action === "cancel") await choose(false);
      if (action === "resume") await resumeInWindow();
      if (action === "stop") {
        engine.cancelTurn.mockResolvedValueOnce({ outcome: "no_active_turn" });
        await stop();
      }
      if (action === "archive") db.exec("UPDATE workspaces SET state = 'archived'");
      if (action === "hide") db.exec("UPDATE sessions SET is_hidden = 1");
      if (action === "delete") db.exec("DELETE FROM sessions");
      invalidate(["workspaces", "sessions"]);
      expect((await queue()).limit?.continues).toBeFalsy();
      await vi.advanceTimersByTimeAsync(10 * minute);
      expect(starts()).toEqual(action === "person" || action === "operator" ? ["A", "B"] : ["A"]);
    }
  );

  it("holds a post-Stop send when the stopped turn ends at a usage limit", async () => {
    await sendInOrder("A", "held");
    await stopped("A");
    await send("later");
    fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(starts()).toEqual(["A"]);
    expect(await ids()).toEqual(["later", "held"]);
    await resumeInWindow();
    expect(wireTurnId()).toBe("later");
  });

  it("keeps a scheduled limit through a failure until an agent's Stop cancels it", async () => {
    await limited();
    await choose(true);
    await enqueueMessage({ ...message("held"), turnId: "held" }, fromChat);
    reportInterruption(sessionId, undefined, true);
    expect((await queue()).limit).toEqual({ resetsAt, continues: true });
    engine.cancelTurn.mockResolvedValueOnce({ outcome: "no_active_turn" });
    await stopSession({ sessionId }, fromAssistant);
    expect(await queue()).toMatchObject({ paused: "stopped", stoppedBy: fromAssistant });
    expect((await queue()).limit).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5 * minute);
    expect(starts()).toEqual(["A"]);
  });

  it("drains waiting rows when a later turn succeeds", async () => {
    await sendInOrder("A", "waiting");
    windows([{ id: "five_hour", status: "limited", resetsAt }]);
    fail();
    await choose(true);
    await send("B");
    end("B");
    await vi.advanceTimersByTimeAsync(5 * minute);
    expect(starts()).toEqual(["A", "B", "waiting"]);
  });

  it.each(["stopped", "failed"] as const)(
    "preserves a standing %s pause until Resume",
    async (reason) => {
      preference(true);
      await sendInOrder("A", "B");
      if (reason === "stopped") {
        await stopped("A");
        end("A", "cancelled");
      } else fail("network");
      await send("C");
      windows([{ id: "five_hour", usedPercent: 100, resetsAt }], "limited");
      fail();
      expect(await queue()).toEqual({
        paused: reason,
        ...(reason === "stopped" && { stoppedBy: fromPerson }),
        items: [{ id: "B", text: "Message B", images: 0, state: "waiting" }],
      });
      expect(await run(api.session, { sessionId })).toMatchObject({
        error_message: "Provider refused this turn",
      });
      await vi.advanceTimersByTimeAsync(5 * minute);
      expect(starts()).toEqual(["A", "C"]);
      await resumeInWindow();
      expect(starts()).toEqual(["A", "C", "B"]);
    }
  );

  it("waits for the person's Continue when a stopped turn hits a usage limit with an empty queue", async () => {
    preference(true);
    await send("A");
    await stopped("A");
    windows([{ id: "primary", usedPercent: 100, resetsAt }], "limited");
    fail();
    expect(await queue()).toEqual({
      items: [],
      paused: "limit",
      limit: { resetsAt, continues: false },
    });
    await vi.advanceTimersByTimeAsync(resetsAt - now + minute);
    expect(starts()).toEqual(["A"]);
    await choose(true);
    expect(engine.startTurn.mock.lastCall![0].input).toBe("Continue.");
    expect(starts()).toHaveLength(2);
  });

  it("keeps an empty queue waiting at a usage limit after the Stop RPC rejects", async () => {
    preference(true);
    await send("A");
    engine.cancelTurn.mockRejectedValueOnce(new Error("Lost Stop reply"));
    await expect(stop()).resolves.toEqual({ unconfirmed: true });
    expect(wireTurnId()).toBe("A");
    windows([{ id: "primary", usedPercent: 100, resetsAt }], "limited");
    fail();
    await vi.advanceTimersByTimeAsync(resetsAt - now + minute);
    expect(starts()).toEqual(["A"]);
    expect(await queue()).toEqual({
      items: [],
      paused: "limit",
      limit: { resetsAt, continues: false },
    });
  });

  it.each([false, true])(
    "waits at a stopped turn's usage limit when Stop held a row (resumed before the end: %s)",
    async (resume) => {
      preference(true);
      await sendInOrder("A", "waiting");
      windows([{ id: "primary", usedPercent: 100, resetsAt }], "limited");
      await stopped("A");
      if (resume) await resumeInWindow();
      fail();
      expect((await queue()).paused).toBe(resume ? "limit" : "stopped");
      if (resume) expect((await queue()).limit).toEqual({ resetsAt, continues: false });
      await vi.advanceTimersByTimeAsync(5 * minute);
      expect(starts()).toEqual(["A"]);
      expect(await ids()).toEqual(["waiting"]);
      if (resume) await choose(true);
      else await resumeInWindow();
      expect(starts()).toEqual(["A", "waiting"]);
    }
  );

  it("returns the sending head to a limit pause when its echo never arrived", async () => {
    preference(true);
    await sendInOrder("A", "head");
    engine.startTurn.mockResolvedValueOnce(undefined);
    end("A");
    await vi.advanceTimersByTimeAsync(0);
    expect((await queue()).items[0]?.state).toBe("sending");
    windows([{ id: "five_hour", usedPercent: 100, resetsAt }], "limited");
    fail();
    expect(await queue()).toMatchObject({
      paused: "limit",
      limit: { resetsAt, continues: true },
      items: [waitingRow("head")],
    });
    await vi.advanceTimersByTimeAsync(3 * minute);
    expect(engine.startTurn.mock.lastCall![0].input).toBe("Message head");
    expect(starts()).toHaveLength(3);
  });

  it("retains a rate_limit's own words even with a future rejected window", async () => {
    preference(true);
    await send("A");
    windows([{ id: "five_hour", status: "limited", resetsAt }]);
    const refusal = "You've hit your 5-hour limit · resets 5:20am";
    fail("rate_limit", refusal);
    expect(await queue()).toEqual({ paused: null, items: [] });
    expect(await run(api.session, { sessionId })).toMatchObject({ error_message: refusal });
    await vi.advanceTimersByTimeAsync(5 * minute);
    expect(starts()).toEqual(["A"]);
  });

  it("shares one clock between opted-in chats and releases it when none are armed", async () => {
    const later = sessionId;
    const offset = 17_321;
    await limited(resetsAt + offset);
    const idle = vi.getTimerCount();
    await choose(true);
    expect(vi.getTimerCount()).toBe(idle + 1);
    await choose(false);
    expect(vi.getTimerCount()).toBe(idle);
    await choose(true);
    sessionId = crypto.randomUUID();
    db.prepare("INSERT INTO sessions (id, workspace_id) VALUES (?, 'w')").run(sessionId);
    await limited();
    const timers = vi.getTimerCount();
    await choose(true);
    expect(vi.getTimerCount()).toBe(timers);
    engine.startTurn.mockResolvedValue(undefined);
    const continuedChats = () =>
      engine.startTurn.mock.calls.flatMap(([p]) => (p.input === "Continue." ? [p.sessionId] : []));
    await vi.advanceTimersByTimeAsync(3 * minute - 1);
    expect(continuedChats()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(continuedChats()).toEqual([sessionId]);
    const setTimer = vi.spyOn(globalThis, "setTimeout");
    await vi.advanceTimersByTimeAsync(offset - 1);
    expect(continuedChats()).toEqual([sessionId]);
    await vi.advanceTimersByTimeAsync(1);
    expect(continuedChats()).toEqual([sessionId, later]);
    expect(setTimer).not.toHaveBeenCalledWith(expect.any(Function), minute);
    expect(vi.getTimerCount()).toBe(timers - 1);
    await vi.advanceTimersByTimeAsync(60 * minute);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops waiting when another turn starts, and leaves a newer stored turn alone", async () => {
    preference(true);
    await limited();
    expect((await queue()).limit?.continues).toBe(true);
    await agent.startTurn(sessionId, "other", "codex-app-server", "Elsewhere", {
      cwd: "/tmp/repo",
    });
    expect((await queue()).limit).toBeUndefined();
    windows([{ id: "primary", usedPercent: 100, resetsAt }], "limited");
    fail();
    expect((await queue()).limit).toEqual({ resetsAt, continues: true });
    db.prepare(
      "INSERT INTO turns (session_id, turn_id, started_at, ended_at) VALUES (?, 'newer', ?, ?)"
    ).run(sessionId, seq + 1, seq + 2);
    await vi.advanceTimersByTimeAsync(5 * minute);
    expect(starts()).toEqual(["A", "other"]);
  });

  it("shows the fixed UTC reset and continuation choice in list, wait and read", async () => {
    const reset = Date.UTC(2026, 10, 24, 4, 10);
    const note = /stopped on a usage limit, resets 2026-11-24 04:10 UTC, continues by itself/g;
    await limited(reset);
    await choose(true);
    const host = createDeusHost();
    const view = await host.view(caller, sessionId, { last: 1 });
    expect(view.note).toMatch(note);
    expect(view.turns.at(-1)?.error).toBe("Provider refused this turn");
    const operator = createOperator(host);
    for (const [name, args] of [
      ["list_sessions", {}],
      ["wait_for_sessions", { sessions: [sessionId], wait: 0 }],
      ["read_session", { session: sessionId }],
    ] as const) {
      const reply = await operator.call(name, args, caller);
      expect(reply.match(note)).toHaveLength(1);
    }
    vi.setSystemTime(reset + 1);
    expect(await operator.call("list_sessions", {}, caller)).toMatch(note);
    await choose(false);
    expect(await operator.call("list_sessions", {}, caller)).not.toContain("continues by itself");
  });

  it("reads the next full transcript page a minute after a usage limit", async () => {
    await run(api.sendMessage, { ...message("A"), turnId: "A", content: "x".repeat(21_000) });
    windows([{ id: "primary", usedPercent: 100, resetsAt }], "limited");
    fail();
    const operator = createOperator(createDeusHost());
    const args = { session: sessionId, full: true };
    const first = await operator.call("read_session", args, caller);
    const page = first.match(/page: "([^"]+)"/)?.[1];
    expect(page).toBeTruthy();
    await vi.advanceTimersByTimeAsync(minute);
    const second = await operator.call("read_session", { ...args, page }, caller);
    expect(second).toContain("Provider refused this turn");
  });

  it("reopens a saved usage-limit error without a reset or an automatic send", async () => {
    await limited();
    await choose(true);
    await agent.shutdown();
    vi.clearAllTimers();
    vi.resetModules();
    const fresh = await import("../../../src/services/agent/queue");
    const { createDeusHost } = await import("../../../src/services/assistants/host");
    expect(fresh.queuedMessages(sessionId)).toEqual({ paused: null, items: [] });
    expect(() => fresh.continueAfterLimit(sessionId, true)).toThrow(/reset time/i);
    const [entry] = await createDeusHost().list(caller, {});
    expect(entry).toMatchObject({
      status: "error",
      note: "stopped on a usage limit",
    });
    await vi.advanceTimersByTimeAsync(24 * 60 * minute);
    expect(starts()).toEqual(["A"]);
  });
});
