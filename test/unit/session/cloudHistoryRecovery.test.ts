import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionSnapshotEventSchema, type SessionSnapshotEvent } from "@deus-hq/api";
import { SCHEMA_SQL } from "@shared/schema";
import { QueryClient } from "@tanstack/react-query";
import {
  createStreamCursor,
  hydrateConversation,
  routeEnvelope,
  messagesKey,
  flushDeltas,
  type AgentStreamContext,
} from "@/features/session/lib/agentEventFold";
import type { PaginatedMessages } from "@/features/session/api/session.service";
import { createOptimisticUserMessage } from "@/features/session/lib/optimisticMessage";

const { database, broadcast, invalidate, refreshPr, send } = vi.hoisted(() => ({
  database: vi.fn(),
  broadcast: vi.fn(),
  invalidate: vi.fn(),
  refreshPr: vi.fn(),
  send: vi.fn(),
}));
vi.mock("../../../apps/backend/src/lib/database", () => ({ getDatabase: database }));
vi.mock("../../../apps/backend/src/services/ws.service", () => ({ broadcast }));
vi.mock("../../../apps/backend/src/services/query-engine", () => ({ invalidate }));
vi.mock("../../../apps/backend/src/services/pr-snapshot.service", () => ({
  refreshPrSnapshotForSession: refreshPr,
}));
vi.mock("../../../apps/backend/src/services/agent/cloud/config", () => ({
  setCloudConnectHook: vi.fn(),
  setCloudIdentityChangedHandler: vi.fn(),
  runCloudConnectHook: vi.fn(),
  getCloudConfig: () => ({
    baseUrl: "https://agnt.test",
    apiKey: "agnt_test",
    deusCloudSessionToken: "workos-test",
  }),
  getCloudConnectionIdentity: () => "history-test",
}));
vi.mock("@deus-hq/sdk", () => ({
  createSession: vi.fn(),
}));
vi.mock("../../../apps/backend/src/services/agent/tool-relay", () => ({
  relay: vi.fn(),
  cancelSessionRelays: vi.fn(() => []),
}));
let onFrame: (frame: Record<string, unknown>) => void;
vi.mock("../../../apps/backend/src/services/agent/cloud/session-socket", () => ({
  connectSessionSocket: (options: { onFrame: typeof onFrame }) => {
    onFrame = options.onFrame;
    return { ready: async () => {}, send, close: vi.fn(), isOpen: () => true };
  },
}));

import { createAgentEventHandler } from "../../../apps/backend/src/services/agent/event-handler";
import {
  ensureCloudSession,
  initCloudDriver,
  shutdownCloudDriver,
  startCloudTurn,
} from "../../../apps/backend/src/services/agent/cloud/driver";
import {
  persistSessionWorking,
  persistLastUserMessageAt,
} from "../../../apps/backend/src/services/agent/persistence";
import { attachParts, getMessages } from "../../../apps/backend/src/db/queries";

const SESSION = "deus-history";
const PROVIDER = "agnt-history";
const T = Date.parse("2026-09-06T12:00:00Z");
type SnapshotMessage = NonNullable<SessionSnapshotEvent["messages"]>[number];
function message(
  id: string,
  index: number,
  turnId = "turn-1",
  role: "user" | "assistant" = "assistant"
): SnapshotMessage {
  return {
    id,
    sessionId: PROVIDER,
    turnId,
    messageIndex: index,
    outputIndex: role === "user" ? 0 : index + 1,
    role,
    createdAt: T + index * 1000,
    parts: [
      {
        type: "text",
        id: `part-${id}`,
        sessionId: PROVIDER,
        messageId: id,
        text: id,
        state: "done",
      },
    ],
  };
}
function snapshot(
  messages: SnapshotMessage[],
  state: Partial<SessionSnapshotEvent["state"]> = {}
): SessionSnapshotEvent {
  return SessionSnapshotEventSchema.parse({
    type: "session.snapshot",
    state: {
      sessionId: PROVIDER,
      organizationId: "org",
      workspaceId: "agnt-workspace",
      status: "ready",
      currentTurnId: null,
      turns: [],
      ...state,
    },
    messages,
  });
}
function ended(turnId: string, over = {}) {
  return {
    turnId,
    stopReason: "end_turn",
    endedAt: T + 10_000,
    cost: 0.5,
    tokens: { input: 10, output: 2 },
    ...over,
  };
}

describe("cloud history through the socket driver, real SQLite and desktop cache", () => {
  let db: Database.Database;
  let directory: string;
  let handler: ReturnType<typeof createAgentEventHandler>;
  let ui: AgentStreamContext;
  async function connect() {
    handler = createAgentEventHandler();
    initCloudDriver(handler);
    await ensureCloudSession(SESSION);
  }
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) =>
        Response.json(String(url).includes("/dashboard/sessions/") ? { token: "test-token" } : {})
      )
    );
    directory = mkdtempSync(join(tmpdir(), "deus-cloud-history-"));
    db = new Database(join(directory, "history.db"));
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_SQL);
    db.exec(`INSERT INTO repositories (id, name, root_path) VALUES ('repo', 'repo', '/tmp/repo');
      INSERT INTO workspaces (id, repository_id, slug, kind, provider_workspace_id) VALUES ('workspace', 'repo', 'cloud', 'cloud', 'agnt-workspace');
      INSERT INTO sessions (id, workspace_id, agent_harness, provider_session_id) VALUES ('${SESSION}', 'workspace', 'claude-code', '${PROVIDER}');`);
    database.mockImplementation(() => db);
    ui = {
      queryClient: new QueryClient(),
      activeSessionId: SESSION,
      folds: new Map(),
      cursor: createStreamCursor(),
      requestRefetch: vi.fn(),
      scheduleFlush: () => {
        const fold = ui.folds.get(SESSION);
        if (fold) flushDeltas(ui.queryClient, SESSION, fold);
      },
    };
    broadcast.mockImplementation((raw) => {
      const frame = JSON.parse(raw);
      if (frame.event === "agent:snapshot") hydrateConversation(ui, frame.data);
      if (frame.event === "agent:event") routeEnvelope(ui, frame.data);
    });
    await connect();
  });
  afterEach(() => {
    shutdownCloudDriver();
    db.close();
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const sessionRow = () => db.prepare("SELECT * FROM sessions WHERE id = ?").get(SESSION);
  const rows = () => attachParts(db, getMessages(db, SESSION, { limit: 2000 }));
  const page = () => ui.queryClient.getQueryData<PaginatedMessages>(messagesKey(SESSION))!;
  const hydrated = () =>
    broadcast.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .filter((frame) => frame.event === "agent:snapshot");

  it("keeps each turn's selected account and execution in SQLite and the live desktop cache", async () => {
    const execution = {
      harness: "codex-app-server" as const,
      model: "selected-alias",
      thinkingLevel: "high" as const,
      reportedModels: ["reported-model"],
    };
    const credentialSource = {
      provider: "codex",
      source: "personal_account" as const,
      authMethod: "subscription" as const,
      account: { id: "saved-A", revision: "revision-A", label: "Personal at execution" },
    };
    const attribution = { execution, credentialSource };
    const history = snapshot([message("prompt", 0, "turn-1", "user"), message("answer", 1)], {
      turns: [ended("turn-1", attribution)],
    });
    onFrame(history);
    expect(JSON.parse(rows().find((row) => row.id === "answer")!.turn_attribution!)).toEqual(
      attribution
    );
    expect(
      JSON.parse(page().messages.find((row) => row.id === "answer")!.turn_attribution!)
    ).toEqual(attribution);
    // A thin replay must preserve facts already written; current settings are never consulted.
    onFrame(snapshot(history.messages!, { turns: [ended("turn-1")] }));
    expect(JSON.parse(rows().find((row) => row.id === "answer")!.turn_attribution!)).toEqual(
      attribution
    );
    shutdownCloudDriver();
    await connect();
    onFrame(history);
    expect(
      JSON.parse(page().messages.find((row) => row.id === "answer")!.turn_attribution!)
    ).toEqual(attribution);

    onFrame({ type: "turn.started", sessionId: PROVIDER, turnId: "turn-2", timestamp: T + 11000 });
    const second = {
      execution: { harness: "claude-code", thinkingLevel: "low" },
      credentialSource: {
        provider: "claude",
        source: "personal_account",
        authMethod: "api_key",
        account: { id: "saved-B", revision: "revision-B", label: "Work" },
      },
    };
    onFrame({
      type: "turn.ended",
      sessionId: PROVIDER,
      turnId: "turn-2",
      stopReason: "error",
      timestamp: T + 12000,
      ...second,
    });
    onFrame({
      type: "session.error",
      sessionId: PROVIDER,
      turnId: "turn-2",
      error: { code: "internal", message: "Provider failed" },
      recoverable: false,
    });
    const marker = rows().find((row) => row.turn_id === "turn-2")!;
    expect(marker.turn_stop_reason).toBe("error");
    expect(marker.cancelled_at).toBeNull();
    expect(JSON.parse(marker.turn_attribution!)).toEqual(second);
    expect(
      JSON.parse(page().messages.find((row) => row.id === marker.id)!.turn_attribution!)
    ).toEqual(second);
    expect(rows().filter((row) => row.turn_attribution)).toHaveLength(2);
    expect(sessionRow()).toMatchObject({ error_message: "Provider failed" });
    onFrame(
      snapshot(
        [
          ...history.messages!,
          message("second-prompt", 2, "turn-2", "user"),
          message("late-answer", 3, "turn-2"),
        ],
        { turns: [ended("turn-1"), ended("turn-2", { stopReason: "error" })] }
      )
    );
    expect(rows().some((row) => row.id === marker.id)).toBe(false);
    expect(JSON.parse(rows().find((row) => row.id === "late-answer")!.turn_attribution!)).toEqual(
      second
    );
    expect(
      JSON.parse(page().messages.find((row) => row.id === "late-answer")!.turn_attribution!)
    ).toEqual(second);
    const { account: _account, ...sharedSource } = credentialSource;
    onFrame(
      snapshot(history.messages!, {
        turns: [ended("turn-1", { execution, credentialSource: sharedSource })],
      })
    );
    expect(
      JSON.parse(rows().find((row) => row.id === "answer")!.turn_attribution!).credentialSource
    ).not.toHaveProperty("account");
    expect(
      JSON.parse(page().messages.find((row) => row.id === "answer")!.turn_attribution!)
        .credentialSource
    ).not.toHaveProperty("account");
  });

  it("releases a rejected send and its optimistic prompt so retry works after reconnect", async () => {
    ui.queryClient.setQueryData<PaginatedMessages>(messagesKey(SESSION), {
      messages: [
        createOptimisticUserMessage({ sessionId: SESSION, turnId: "rejected", content: "Hello" }),
      ],
      has_older: false,
      has_newer: false,
    });
    persistSessionWorking(SESSION);
    await startCloudTurn(SESSION, "rejected", "Hello");
    onFrame({
      type: "error",
      code: "MESSAGE_SEND_FAILED",
      messageId: send.mock.calls.at(-1)![0].messageId,
      message: "Provider account unavailable",
    });

    expect(handler.liveTurnId(SESSION)).toBeUndefined();
    expect(sessionRow()).toMatchObject({
      status: "error",
      error_message: expect.stringContaining("Provider account unavailable"),
    });
    expect(rows()).toEqual([]);
    expect(page().messages).toEqual([]);
    onFrame(snapshot([]));
    await expect(startCloudTurn(SESSION, "retry", "Hello")).resolves.toBeUndefined();
    expect(handler.liveTurnId(SESSION)).toBe("retry");
  });

  it.each(["turn.started", "snapshot"])(
    "ignores a delayed rejection after %s proves admission",
    async (admission) => {
      await startCloudTurn(SESSION, "accepted", "Hello");
      const messageId = send.mock.calls.at(-1)![0].messageId;
      const prompt = message("echo-accepted", 0, "accepted", "user");
      if (admission === "turn.started") {
        persistSessionWorking(SESSION);
        onFrame({ type: "turn.started", turnId: "accepted", sessionId: PROVIDER, timestamp: T });
        onFrame({
          type: "message.started",
          sessionId: PROVIDER,
          turnId: "accepted",
          messageId: prompt.id,
          role: "user",
          outputIndex: 0,
          timestamp: T,
        });
      } else {
        onFrame(snapshot([prompt], { status: "running", currentTurnId: "accepted" }));
      }
      onFrame({ type: "error", code: "MESSAGE_SEND_FAILED", messageId, message: "Late refusal" });
      expect(handler.liveTurnId(SESSION)).toBe("accepted");
      expect(sessionRow()).toMatchObject({ status: "working", error_message: null });
      expect(page().messages.map((row) => row.id)).toEqual(["echo-accepted"]);
    }
  );

  it("ignores a previous send's rejection while another send awaits admission", async () => {
    await startCloudTurn(SESSION, "first", "First");
    const firstMessageId = send.mock.calls.at(-1)![0].messageId;
    onFrame(snapshot([], { turns: [ended("first")] }));
    await startCloudTurn(SESSION, "second", "Second");
    persistSessionWorking(SESSION);
    onFrame({
      type: "error",
      code: "MESSAGE_SEND_FAILED",
      messageId: firstMessageId,
      message: "Late refusal",
    });
    expect(handler.liveTurnId(SESSION)).toBe("second");
    expect(sessionRow()).toMatchObject({ status: "working", error_message: null });
  });

  it("restores missed messages, parts, ordering, compactions and accounting without live completion effects", () => {
    const newer = message("newer", 2);
    onFrame({
      type: "message.started",
      sessionId: PROVIDER,
      turnId: newer.turnId,
      messageId: newer.id,
      role: newer.role,
      outputIndex: newer.outputIndex,
      timestamp: newer.createdAt,
    });
    const frame = snapshot([newer, message("prompt", 0, "turn-1", "user"), message("older", 1)], {
      turns: [ended("turn-1")],
      contextUsed: 100,
      contextSize: 1000,
      compactions: [
        {
          compactionId: "compact-1",
          turnId: "turn-1",
          status: "completed",
          summary: "Earlier work",
          timestamp: T + 2500,
        },
      ],
    });
    onFrame(frame);
    const restored = rows();
    expect(restored.map((row) => [row.id, row.seq])).toEqual([
      ["prompt", 1],
      ["older", 2],
      ["newer", 3],
    ]);
    expect(restored.map((row) => row.parts[0].type)).toEqual(["text", "text", "text"]);
    expect(restored[2]).toMatchObject({
      cost: 0.5,
      turn_stop_reason: "end_turn",
      tokens: JSON.stringify({ input: 10, output: 2 }),
    });
    expect(restored[1].cost).toBeNull();
    expect(page().messages.map(({ id, seq, cost }) => [id, seq, cost ?? null])).toEqual(
      restored.map(({ id, seq, cost }) => [id, seq, cost])
    );
    expect(page().compactions?.[0].summary).toBe("Earlier work");
    expect(db.prepare("SELECT summary FROM compactions").all()).toEqual([
      { summary: "Earlier work" },
    ]);
    expect(sessionRow()).toMatchObject({
      message_count: 3,
      status: "idle",
      last_user_message_at: new Date(T).toISOString(),
      context_token_count: 100,
      context_used_percent: 10,
    });
    expect(refreshPr).not.toHaveBeenCalled();
    expect(hydrated()).toHaveLength(1);
    onFrame(frame);
    expect(rows()).toEqual(restored);
    expect(page().messages).toHaveLength(3);
    expect(sessionRow()).toMatchObject({ message_count: 3 });
    expect(refreshPr).not.toHaveBeenCalled();
  });

  it("survives a database close and backend restart without duplicate history or billing", async () => {
    const initial = snapshot([message("prompt", 0, "turn-1", "user"), message("answer", 1)], {
      turns: [ended("turn-1")],
    });
    onFrame(initial);
    shutdownCloudDriver();
    db.close();
    db = new Database(join(directory, "history.db"));
    db.pragma("foreign_keys = ON");
    await connect();
    const after = snapshot([...initial.messages!, message("browser-answer", 2, "turn-2")], {
      turns: [ended("turn-1"), ended("turn-2")],
    });
    onFrame(after);
    onFrame(after);
    expect(rows().map((row) => row.id)).toEqual(["prompt", "answer", "browser-answer"]);
    expect(page().messages.map((row) => row.id)).toEqual(["prompt", "answer", "browser-answer"]);
    expect(db.prepare("SELECT SUM(cost) AS cost FROM messages").get()).toEqual({ cost: 1 });
    expect(sessionRow()).toMatchObject({ message_count: 3 });
    expect(refreshPr).not.toHaveBeenCalled();
  });

  it("restores an in-flight part and continues folding subsequent deltas", () => {
    const active = message("answer", 0);
    active.parts[0] = {
      ...active.parts[0],
      type: "text",
      text: "Recovered chunk",
      state: "streaming",
    } as SnapshotMessage["parts"][number];
    onFrame(snapshot([active], { currentTurnId: "turn-1" }));
    expect(handler.liveTurnId(SESSION)).toBe("turn-1");
    expect(sessionRow()).toMatchObject({ status: "working" });
    onFrame({
      type: "message.part.delta",
      sessionId: PROVIDER,
      turnId: "turn-1",
      messageId: "answer",
      outputIndex: 1,
      partIndex: 0,
      partId: "part-answer",
      delta: { type: "text", text: " continued" },
      timestamp: T + 5000,
    });
    expect(page().messages[0].parts?.[0]).toMatchObject({ text: "Recovered chunk continued" });
    onFrame({
      type: "message.part",
      sessionId: PROVIDER,
      turnId: "turn-1",
      messageId: "answer",
      outputIndex: 1,
      partIndex: 0,
      part: { ...active.parts[0], text: "Recovered chunk continued", state: "done" },
      timestamp: T + 6000,
    });
    expect(rows()[0].parts[0]).toMatchObject({ text: "Recovered chunk continued", state: "done" });
  });

  it("preserves a newly sent turn while importing an older idle snapshot", () => {
    ui.queryClient.setQueryData<PaginatedMessages>(messagesKey(SESSION), {
      messages: [
        createOptimisticUserMessage({
          sessionId: SESSION,
          turnId: "pending",
          content: "New prompt",
        }),
      ],
      compactions: [],
      has_older: false,
      has_newer: false,
    });
    handler.beginTurn(SESSION, "pending");
    persistSessionWorking(SESSION);
    const sentAt = new Date(T + 60_000).toISOString();
    persistLastUserMessageAt(SESSION, sentAt);
    onFrame(snapshot([message("old", 0, "turn-1", "user")], { turns: [ended("turn-1")] }));
    expect(handler.liveTurnId(SESSION)).toBe("pending");
    expect(page().messages.at(-1)).toMatchObject({ id: "echo-pending", role: "user" });
    expect(sessionRow()).toMatchObject({
      status: "working",
      error_message: null,
      last_user_message_at: sentAt,
    });
  });

  it("releases an unobserved admission when the snapshot proves that turn ended", () => {
    handler.beginTurn(SESSION, "turn-1");
    persistSessionWorking(SESSION);
    onFrame(snapshot([message("old", 0)], { turns: [ended("turn-1")] }));
    expect(handler.liveTurnId(SESSION)).toBeUndefined();
    expect(sessionRow()).toMatchObject({ status: "idle" });
  });

  it("does not let historical errors overwrite a currently running turn", () => {
    onFrame(
      snapshot([message("old", 0), message("current", 1, "turn-2")], {
        currentTurnId: "turn-2",
        turns: [
          ended("turn-1", {
            stopReason: "error",
            error: { category: "internal", message: "Old failure" },
          }),
        ],
      })
    );
    expect(handler.liveTurnId(SESSION)).toBe("turn-2");
    expect(sessionRow()).toMatchObject({ status: "working", error_message: null });
    expect(refreshPr).not.toHaveBeenCalled();
  });

  it("rolls back a failed restore and does not publish a half-restored fold", () => {
    onFrame(snapshot([message("original", 0)]));
    const before = rows();
    broadcast.mockClear();
    handler.beginTurn(SESSION, "turn-1");
    onFrame({ type: "turn.started", sessionId: PROVIDER, turnId: "turn-1", timestamp: T });
    db.exec(
      "CREATE TRIGGER fail_restore BEFORE INSERT ON parts WHEN NEW.id = 'part-rejected' BEGIN SELECT RAISE(ABORT, 'restore write failed'); END;"
    );
    onFrame(
      snapshot([message("inserted", 0), message("rejected", 1)], { turns: [ended("turn-1")] })
    );
    expect(rows()).toEqual(before);
    expect(sessionRow()).toMatchObject({ message_count: 1 });
    expect(hydrated()).toHaveLength(0);
    expect(page().messages.map((row) => row.id)).toEqual(["original"]);
    expect(handler.liveTurnId(SESSION)).toBe("turn-1");
    expect(refreshPr).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "keeps a deferred actionable error (assistant output: %s)",
    (hasAnswer) => {
      const failure = snapshot(hasAnswer ? [message("answer", 0)] : [], {
        status: "error",
        turns: [
          ended("turn-1", {
            stopReason: "error",
            error: { category: "internal", message: "Agent turn failed" },
          }),
        ],
      });
      onFrame(failure);
      onFrame({
        type: "session.error",
        turnId: "turn-1",
        recoverable: false,
        error: { code: "provider_auth", message: "Reconnect your provider account" },
      });
      onFrame(failure);
      expect(sessionRow()).toMatchObject({
        status: "error",
        error_category: "provider_auth",
        error_message: "Reconnect your provider account",
      });
    }
  );

  it("rejects malformed or mismatched transcripts without erasing existing rows", () => {
    onFrame(snapshot([message("original", 0)]));
    const before = rows();
    broadcast.mockClear();
    onFrame({ ...snapshot([]), messages: [{ ...message("invalid", 1), role: "broken" }] });
    onFrame(snapshot([], { sessionId: "another-provider-session" }));
    expect(rows()).toEqual(before);
    expect(hydrated()).toHaveLength(0);
  });

  it("replaces an earlier error when a different cloud turn failed while disconnected", () => {
    onFrame(snapshot([], { status: "error", turns: [ended("old", { stopReason: "error" })] }));
    onFrame({
      type: "session.error",
      turnId: "old",
      recoverable: false,
      error: { code: "provider_auth", message: "Reconnect your provider account" },
    });
    onFrame(
      snapshot([], {
        status: "error",
        turns: [
          ended("new", {
            stopReason: "error",
            error: { category: "tool", message: "Build failed" },
          }),
        ],
      })
    );
    expect(sessionRow()).toMatchObject({ error_category: "tool", error_message: "Build failed" });
  });

  it("restores more than 100 messages", () => {
    onFrame(
      snapshot(Array.from({ length: 250 }, (_, index) => message(`message-${index}`, index)))
    );
    expect(rows()).toHaveLength(250);
    expect(sessionRow()).toMatchObject({ message_count: 250 });
  });

  it.each(["cancelled", "error", "end_turn"])(
    "keeps a %s outcome beside its user prompt",
    (stopReason) => {
      onFrame(
        snapshot(
          [message("cancelled-prompt", 0, "turn-1", "user"), message("later", 1, "turn-2")],
          {
            turns: [
              ended("turn-1", { stopReason, execution: { harness: "codex-app-server" } }),
              ended("turn-2"),
            ],
          }
        )
      );
      for (const messages of [rows(), page().messages]) {
        expect(messages.map((row) => row.turn_id)).toEqual(["turn-1", "turn-1", "turn-2"]);
        expect(messages.map((row) => row.seq)).toEqual([1, 2, 3]);
        expect(messages[1]).toMatchObject({ role: "assistant", turn_stop_reason: stopReason });
      }
    }
  );

  it("replaces a temporary cancellation marker when recovery finds the real answer", () => {
    const prompt = message("prompt", 0, "turn-1", "user");
    const turns = [ended("turn-1", { stopReason: "cancelled" })];
    onFrame(snapshot([prompt], { turns }));
    expect(rows()).toHaveLength(2);
    expect(page().messages).toHaveLength(2);

    const recovered = snapshot([prompt, message("missed-answer", 1)], { turns });
    onFrame(recovered);
    onFrame(recovered);
    for (const messages of [rows(), page().messages]) {
      expect(messages.map((row) => row.id)).toEqual(["prompt", "missed-answer"]);
      expect(messages[1]).toMatchObject({ turn_stop_reason: "cancelled", cost: 0.5 });
    }
    expect(sessionRow()).toMatchObject({ message_count: 2 });
  });

  it.each([true, false])(
    "recovers a missed final answer without double counting (restated metrics: %s)",
    (restated) => {
      onFrame({
        type: "message.started",
        sessionId: PROVIDER,
        turnId: "turn-1",
        messageId: "earlier-answer",
        role: "assistant",
        outputIndex: 1,
        timestamp: T,
      });
      onFrame({
        type: "turn.ended",
        sessionId: PROVIDER,
        ...ended("turn-1"),
        timestamp: T + 10_000,
      });
      expect(rows()[0]).toMatchObject({ cost: 0.5 });
      onFrame(
        snapshot([message("earlier-answer", 0), message("missed-answer", 1)], {
          turns: [ended("turn-1", restated ? {} : { cost: undefined, tokens: undefined })],
        })
      );
      for (const messages of [rows(), page().messages]) {
        expect(messages.reduce((total, row) => total + (row.cost ?? 0), 0)).toBe(0.5);
        expect(messages[0].turn_stop_reason).toBeNull();
        expect(messages[1]).toMatchObject({ turn_stop_reason: "end_turn" });
        expect(messages[restated ? 1 : 0].cost).toBe(0.5);
      }
    }
  );
});
