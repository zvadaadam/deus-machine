// The engine in the backend's process: AgentServerClient ⇄ the in-process
// channel ⇄ the real AgentServer ⇄ a scripted fake runtime, with the deus
// seams the backend's AgentLink calls around it (beginTurnStart,
// beforeCancel) and the host the deus tools reach (HostRpc, notifyTitle).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentServerClient } from "@zvada/agent-server/client";
import type { LifecycleEvent, TurnStartParams } from "@zvada/agent-server/protocol";
import type { DecodedWireEventEnvelope } from "@shared/protocol-types";

const { mockCheckpoint, mockAapServers } = vi.hoisted(() => ({
  mockCheckpoint: vi.fn(async () => {}),
  mockAapServers: vi.fn(() => ({})),
}));
vi.mock("../agents/core/checkpoint", () => ({ createCheckpoint: mockCheckpoint }));
vi.mock("../agents/core/engine", () => ({
  getRuntime: () => {
    throw new Error("tests pass a runtime");
  },
  currentAapServers: mockAapServers,
}));

import { beforeCancel, beginTurnStart, startEngine, stopEngine } from "../index";
import { HostRpc, notifyTitle } from "../host-link";
import { trackedSessions } from "../session-tracker";

const T = 1_700_000_000_000;

/** Scripted engine: a turn replays a fixed event sequence, or hangs. */
function fakeRuntime(hang = false) {
  const started: TurnStartParams[] = [];
  const runtime = {
    harnesses: ["claude-code", "codex-app-server"],
    capabilities: () => ({
      multiTurn: true,
      sessionResume: true,
      modelSwitch: "in_session",
      thinkingLevels: true,
      images: true,
      files: [],
      mcpServers: true,
      permissionRequests: false,
      rejectionMessages: false,
    }),
    async run(
      request: TurnStartParams & { sessionId: string; turnId: string },
      sink: { emit: (e: LifecycleEvent) => void | Promise<void> }
    ) {
      started.push(request);
      const { sessionId, turnId } = request;
      await sink.emit({ type: "turn.started", sessionId, turnId, timestamp: T });
      await sink.emit({
        type: "session.created",
        sessionId,
        nativeSessionId: "native-abc",
        harness: "claude-code",
        timestamp: T,
      });
      if (hang) await new Promise(() => {});
      await sink.emit({
        type: "turn.ended",
        sessionId,
        turnId,
        stopReason: "end_turn",
        timestamp: T,
      });
    },
    admission: () => ({ status: "new" }),
    async cancel() {
      return { confirmed: true };
    },
    async closeSession() {},
    respondPermission: () => false,
    async authStatus(harnesses: string[]) {
      return harnesses.map((harness) => ({ harness, state: "signed_out", methods: [] }));
    },
    onCliProgress: () => () => {},
    onAuthUpdated: () => () => {},
    async shutdown() {},
  };
  return { runtime: runtime as never, started };
}

describe("the engine in the backend's process", () => {
  let client: AgentServerClient;
  let envelopes: DecodedWireEventEnvelope[];
  const host = { request: vi.fn(), title: vi.fn() };

  async function open(hang = false) {
    const fake = fakeRuntime(hang);
    client = await AgentServerClient.attach(startEngine(host, fake.runtime));
    envelopes = [];
    client.onEvent((envelope) => envelopes.push(envelope));
    await client.initialize();
    await client.subscribeAll();
    return fake;
  }

  /** What AgentLink.startTurn does. */
  async function startTurn(params: TurnStartParams) {
    const turn = beginTurnStart(params);
    try {
      return await client.startTurn(turn.params);
    } catch (err) {
      turn.refused();
      throw err;
    }
  }

  beforeEach(() => {
    trackedSessions.clear();
    vi.clearAllMocks();
    mockAapServers.mockReturnValue({});
  });

  afterEach(async () => {
    await client?.close();
    await stopEngine();
  });

  it("handshakes on the standard wire and reports the two deus harnesses", async () => {
    await open();
    const init = await client.initialize();
    expect(Object.keys(init.harnesses).sort()).toEqual(["claude-code", "codex-app-server"]);
    expect(init.server.name).toBe("deus-agent-server");
    await expect(client.authStatus({ harnesses: ["claude-code"] })).resolves.toEqual([
      { harness: "claude-code", state: "signed_out", methods: [] },
    ]);
  });

  it("streams a turn's events in seq order and tracks its session", async () => {
    await open();
    await startTurn({
      sessionId: "sess-1",
      turnId: "turn-1",
      input: "hello",
      config: { harness: "claude-code", cwd: "/tmp/ws", additionalDirectories: ["/tmp/extra"] },
    });
    await vi.waitFor(() => expect(envelopes.map((e) => e.event.type)).toContain("turn.ended"));
    expect(envelopes.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(trackedSessions.get("sess-1")).toMatchObject({
      harness: "claude-code",
      cwd: "/tmp/ws",
      additionalDirectories: ["/tmp/extra"],
      nativeSessionId: "native-abc",
    });
    // turn.ended cleared the running turn.
    expect(trackedSessions.get("sess-1")?.turnId).toBeUndefined();
  });

  it("gives a Claude turn the registered AAP servers, and a Codex turn none", async () => {
    const fake = await open();
    mockAapServers.mockReturnValue({ app: { type: "http", url: "http://127.0.0.1:9/mcp" } });
    await startTurn({
      sessionId: "claude",
      turnId: "t1",
      input: "x",
      config: { harness: "claude-code", cwd: "/tmp" },
    });
    await startTurn({
      sessionId: "codex",
      turnId: "t1",
      input: "x",
      config: { harness: "codex-app-server", cwd: "/tmp" },
    });
    await vi.waitFor(() => expect(fake.started).toHaveLength(2));
    expect(fake.started[0]?.config.mcpServers).toEqual({
      app: { type: "http", url: "http://127.0.0.1:9/mcp" },
    });
    expect(fake.started[1]?.config.mcpServers).toBeUndefined();
  });

  it("forgets a refused turn's config; the corrected retry records its own", async () => {
    await open();
    await expect(
      startTurn({
        sessionId: "sess-r",
        turnId: "bad",
        input: "x",
        config: { harness: "acp", cwd: "/tmp/WRONG" },
      })
    ).rejects.toMatchObject({ code: -32000 });
    expect(trackedSessions.get("sess-r")).toBeUndefined();

    await startTurn({
      sessionId: "sess-r",
      turnId: "good",
      input: "x",
      config: { harness: "claude-code", cwd: "/tmp/RIGHT" },
    });
    expect(trackedSessions.get("sess-r")?.cwd).toBe("/tmp/RIGHT");
  });

  it("refuses a second turn on a busy session, which keeps its turn's config", async () => {
    await open(true);
    await startTurn({
      sessionId: "busy",
      turnId: "a",
      input: "x",
      config: { harness: "claude-code", cwd: "/tmp/first" },
    });
    await vi.waitFor(() => expect(trackedSessions.get("busy")?.turnId).toBe("a"));
    await expect(
      startTurn({
        sessionId: "busy",
        turnId: "b",
        input: "y",
        config: { harness: "claude-code", cwd: "/tmp/second" },
      })
    ).rejects.toMatchObject({ code: -32002 });
    expect(trackedSessions.get("busy")).toMatchObject({ cwd: "/tmp/first", turnId: "a" });
  });

  it("writes a running Claude turn's end checkpoint before a cancel, and none when idle", async () => {
    await open(true);
    await startTurn({
      sessionId: "cancel",
      turnId: "t",
      input: "x",
      config: { harness: "claude-code", cwd: "/tmp/ws" },
    });
    await vi.waitFor(() => expect(trackedSessions.get("cancel")?.turnId).toBe("t"));
    await beforeCancel("cancel");
    expect(mockCheckpoint).toHaveBeenCalledWith("cancel", "t", "end", "/tmp/ws", "[engine]");

    await beforeCancel("idle");
    expect(mockCheckpoint).toHaveBeenCalledOnce();
  });

  it("answers the deus tools from the backend, bounded by their deadline", async () => {
    await open();
    host.request.mockResolvedValueOnce({ diff: "diff --git a b" });
    await expect(HostRpc.requestGetDiff({ sessionId: "s" })).resolves.toEqual({
      diff: "diff --git a b",
    });
    expect(host.request).toHaveBeenCalledWith("getDiff", { sessionId: "s" });

    vi.useFakeTimers();
    try {
      host.request.mockReturnValueOnce(new Promise(() => {}));
      const late = HostRpc.requestGetDiff({ sessionId: "s" });
      const failed = expect(late).rejects.toThrow("getDiff timed out after 10000ms");
      await vi.advanceTimersByTimeAsync(10_000);
      await failed;
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives the backend a session's title, and has nowhere to send it once stopped", async () => {
    await open();
    const title = { sessionId: "s", agentHarness: "claude-code", title: "Fix login" };
    expect(notifyTitle(title)).toBe(true);
    expect(host.title).toHaveBeenCalledWith(title);

    await client.close();
    await stopEngine();
    expect(notifyTitle(title)).toBe(false);
    await expect(HostRpc.requestGetDiff({ sessionId: "s" })).rejects.toThrow(
      "Deus host not connected."
    );
  });
});
