import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  AgentRegistry,
  AgentRuntime,
  BaseAgent,
  type AgentExecuteOptions,
  type AdapterEvent,
} from "@zvada/agent-server/core";
import { AgentServer } from "@zvada/agent-server/server";
import { AgentServerClient, EventGapError, type SessionEventGap } from "@zvada/agent-server/client";
import {
  channelTransport,
  createTextPart,
  DEFAULT_TOKEN_USAGE,
  type WireEventEnvelope,
} from "@zvada/agent-server/protocol";
import { SCHEMA_SQL } from "@shared/schema";
import { sessionEvents, type SessionEvent } from "@shared/api/sessions";
import {
  flushDeltas,
  routeEnvelope,
  messagesKey,
  type AgentStreamContext,
} from "@/features/session/lib/agentEventFold";

const { database, received } = vi.hoisted(() => ({
  database: vi.fn(),
  /** Every frame the backend sent the desktop window's connection. */
  received: vi.fn(),
}));
vi.mock("../../../apps/backend/src/lib/database", () => ({ getDatabase: database }));
// The streams are real; only the socket they send on is replaced.
vi.mock("../../../apps/backend/src/services/ws.service", () => ({
  getConnection: () => ({ ws: { send: received } }),
}));
vi.mock("../../../apps/backend/src/services/query-engine", () => ({ invalidate: vi.fn() }));
vi.mock("../../../apps/backend/src/services/pr-snapshot.service", () => ({
  refreshPrSnapshotForSession: vi.fn(),
}));
vi.mock("../../../apps/backend/src/services/agent/cloud/driver", () => ({
  pushCloudSessionTitle: vi.fn(),
}));
import { createAgentEventHandler } from "../../../apps/backend/src/services/agent/event-handler";
import { _reset, subscribe } from "../../../apps/backend/src/services/streams";
import { persistSessionWorking } from "../../../apps/backend/src/services/agent/persistence";

const SESSION = "native-recovery";
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function transportPair() {
  const channels: ReturnType<typeof channelTransport>[] = [];
  const half = (peer: number) =>
    channelTransport({
      send: (line) => queueMicrotask(() => channels[peer]?.push(line)),
      close: () => queueMicrotask(() => channels[peer]?.end("peer closed")),
    });
  channels.push(half(1), half(0));
  return {
    client: channels[0].transport,
    server: channels[1].transport,
    kill: () => {
      channels[0].end("test outage");
      channels[1].end("test outage");
    },
  };
}

describe("native replay through the published engine, SQLite and desktop fold", () => {
  let db: Database.Database;
  let handler: ReturnType<typeof createAgentEventHandler>;
  let ui: AgentStreamContext;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    db.exec(`INSERT INTO repositories (id, name, root_path) VALUES ('repo', 'repo', '/tmp/repo');
      INSERT INTO workspaces (id, repository_id, slug) VALUES ('workspace', 'repo', 'local');
      INSERT INTO sessions (id, workspace_id, agent_harness) VALUES ('${SESSION}', 'workspace', 'claude-code');`);
    database.mockReturnValue(db);
    handler = createAgentEventHandler();
    ui = {
      queryClient: new QueryClient(),
      activeSessionId: SESSION,
      folds: new Map(),
      requestRefetch: vi.fn(),
      scheduleFlush: () => {
        const fold = ui.folds.get(SESSION);
        if (fold) flushDeltas(ui.queryClient, SESSION, fold);
      },
    };
    // The desktop window follows this chat, as it does once its page is cached.
    _reset();
    subscribe("desktop", "chat", sessionEvents, { sessionId: SESSION });
    received.mockImplementation((raw: string) => {
      const frame = JSON.parse(raw);
      if (frame.type !== "q:event" || frame.event !== sessionEvents.name) return;
      const update: SessionEvent = frame.data;
      if (update.type === "event") routeEnvelope(ui, update.envelope);
    });
  });
  afterEach(() => {
    ui.queryClient.clear();
    db.close();
    vi.restoreAllMocks();
  });
  const row = () => db.prepare("SELECT * FROM sessions WHERE id = ?").get(SESSION);

  it.each([2, 4096])(
    "keeps delivery loss distinct from native success (retention=%s)",
    async (bufferSize) => {
      const finish = gate(),
        reconnect = gate();
      class TestAgent extends BaseAgent {
        readonly harness = "claude-code" as const;
        readonly capabilities = {
          multiTurn: true,
          sessionResume: true,
          modelSwitch: "unsupported" as const,
          thinkingLevels: false,
          images: false,
          files: [],
          mcpServers: false,
          permissionRequests: true,
          rejectionMessages: false,
        };
        async *execute(_input: unknown, options: AgentExecuteOptions) {
          options.onNativeSession?.("native-original");
          yield "visible";
          await finish.promise;
          yield "offline";
        }
      }
      const registry = new AgentRegistry().register(new TestAgent(), (ctx) => ({
        process: (text): AdapterEvent[] => [
          {
            kind: "part-open",
            part: createTextPart({ sessionId: ctx.sessionId, messageId: "" }, String(text), false),
          },
        ],
        finish: () => ({
          usage: { ...DEFAULT_TOKEN_USAGE, input: 12, output: 5 },
          cost: 0.125,
          stopReason: "end_turn",
        }),
      }));
      const server = new AgentServer(new AgentRuntime(registry), { bufferSize });
      const native: WireEventEnvelope[] = [];
      server.onEvent((event) => native.push(event));
      let pair = transportPair(),
        dials = 0;
      const client = await AgentServerClient.fromTransportFactory(
        async () => {
          if (dials++ > 0) {
            await reconnect.promise;
            pair = transportPair();
          }
          server.attach(pair.server);
          return pair.client;
        },
        { reconnectDelayMs: 1 }
      );
      const gaps: SessionEventGap[] = [];
      client.onEvent((event) => handler.handle(event));
      client.onEventGap((gap) => {
        gaps.push(gap);
        handler.handleEventGap(gap);
      });
      try {
        persistSessionWorking(SESSION);
        handler.beginTurn(SESSION, "turn-1");
        await client.startTurn({
          sessionId: SESSION,
          turnId: "turn-1",
          input: "test",
          config: { harness: "claude-code", cwd: "/tmp" },
        });
        handler.confirmTurn(SESSION, "turn-1");
        await vi.waitFor(() =>
          expect(JSON.stringify(ui.queryClient.getQueryData(messagesKey(SESSION)))).toContain(
            "visible"
          )
        );
        pair.kill();
        finish.release();
        await vi.waitFor(() =>
          expect(native.some(({ event }) => event.type === "turn.ended")).toBe(true)
        );
        expect(handler.liveTurnId(SESSION)).toBe("turn-1");
        reconnect.release();
        await vi.waitFor(() => expect(handler.liveTurnId(SESSION)).toBeUndefined());
        expect(row()).toMatchObject({
          status: bufferSize === 2 ? "error" : "idle",
          agent_session_id: "native-original",
        });
        expect(gaps.map((gap) => gap.reason)).toEqual(bufferSize === 2 ? ["evicted"] : []);
        expect(native.at(-1)?.event).toMatchObject({
          type: "turn.ended",
          stopReason: "end_turn",
          cost: 0.125,
        });
        if (bufferSize === 2)
          expect(row()).toMatchObject({
            error_message: expect.stringContaining("transcript is incomplete"),
          });
        else
          expect(JSON.stringify(ui.queryClient.getQueryData(messagesKey(SESSION)))).toContain(
            "offline"
          );
        // Delivery damage belongs to one turn, not the whole session.
        handler.beginTurn(SESSION, "next");
        persistSessionWorking(SESSION);
        await client.startTurn({
          sessionId: SESSION,
          turnId: "next",
          input: "next",
          config: { harness: "claude-code", cwd: "/tmp" },
        });
        await vi.waitFor(() => expect(handler.liveTurnId(SESSION)).toBeUndefined());
        expect(row()).toMatchObject({ status: "idle", error_message: null });
      } finally {
        finish.release();
        reconnect.release();
        await client.close();
        await server.shutdown();
      }
    }
  );

  it("keeps Stop available on unconfirmed loss and ignores a late reply after a successor starts", () => {
    handler.beginTurn(SESSION, "lost");
    handler.confirmTurn(SESSION, "lost");
    const gap = {
      sessionId: SESSION,
      reason: "replay_failed" as const,
      error: new EventGapError("test loss"),
    };
    expect(handler.handleEventGap(gap)).toBe("lost");
    handler.settleEventGap(SESSION, "lost", false);
    expect(row()).toMatchObject({
      status: "working",
      error_message: expect.stringContaining("not confirmed it stopped"),
    });
    expect(handler.beginTurn(SESSION, "unsafe")).toBe(false);
    handler.settleEventGap(SESSION, "lost", true);
    expect(row()).toMatchObject({ status: "error" });
    expect(handler.beginTurn(SESSION, "new")).toBe(true);
    persistSessionWorking(SESSION);
    handler.settleEventGap(SESSION, "lost", true);
    expect(handler.liveTurnId(SESSION)).toBe("new");
    expect(row()).toMatchObject({ status: "working", error_message: null });
    // The native cancel can finish before the old replay succeeds. Preserve
    // that historical transcript without lending it the new turn's status.
    handler.confirmTurn(SESSION, "new");
    handler.handle({
      sessionId: SESSION,
      seq: 1,
      event: { type: "turn.started", sessionId: SESSION, turnId: "lost", timestamp: 1 },
    });
    handler.handle({
      sessionId: SESSION,
      seq: 2,
      event: {
        type: "error",
        sessionId: SESSION,
        turnId: "lost",
        timestamp: 2,
        category: "internal",
        message: "Historical failure",
        recoverable: false,
      },
    });
    handler.handle({
      sessionId: SESSION,
      seq: 3,
      event: {
        type: "turn.ended",
        sessionId: SESSION,
        turnId: "lost",
        timestamp: 3,
        stopReason: "end_turn",
        cost: 0.2,
      },
    });
    expect(handler.liveTurnId(SESSION)).toBe("new");
    expect(row()).toMatchObject({ status: "working", error_message: null });
    handler.handle({
      sessionId: SESSION,
      seq: 4,
      event: {
        type: "turn.ended",
        sessionId: SESSION,
        turnId: "new",
        timestamp: 4,
        stopReason: "error",
        error: { category: "auth", message: "New failure" },
      },
    });
    handler.handle({
      sessionId: SESSION,
      seq: 5,
      event: {
        type: "turn.ended",
        sessionId: SESSION,
        turnId: "lost",
        timestamp: 3,
        stopReason: "end_turn",
        cost: 0.2,
      },
    });
    expect(row()).toMatchObject({ status: "error", error_message: "New failure" });
    handler.beginTurn(SESSION, "pending");
    expect(handler.handleEventGap({ ...gap, reason: "server_restarted" })).toBeUndefined();
    expect(handler.liveTurnId(SESSION)).toBe("pending");
  });

  it.each(["server_restarted", "session_missing"] as const)(
    "settles an already-damaged turn when %s proves it gone",
    (reason) => {
      handler.beginTurn(SESSION, "lost");
      handler.confirmTurn(SESSION, "lost");
      handler.handleEventGap({
        sessionId: SESSION,
        reason: "evicted",
        error: new EventGapError("test loss"),
      });
      handler.handleEventGap({ sessionId: SESSION, reason, error: new EventGapError("gone") });
      expect(handler.liveTurnId(SESSION)).toBeUndefined();
      expect(row()).toMatchObject({
        status: "error",
        error_message: expect.stringContaining("transcript is incomplete"),
      });
      expect(handler.beginTurn(SESSION, "retry")).toBe(true);
    }
  );
});
