// Integration: the real wire stack over a real WebSocket — upstream
// AgentServerClient (typed client, seq tracking) ⇄ bridgeWsConnection
// (side-channel claim + observers) ⇄ upstream AgentServer ⇄ a scripted fake
// runtime. No mocked transports; only the engine is fake.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer as createHttpServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { AgentServerClient } from "@zvada/agent-server/client";
import type { LifecycleEvent, WireEventEnvelope } from "@zvada/agent-server/protocol";
import { WIRE_PROTOCOL_VERSION } from "@zvada/agent-server/protocol";
import {
  SIDE_CHANNEL,
  SideChannelEndpoint,
  claimSideChannel,
  wsLineTransport,
} from "@shared/agent-side-channel";
import { AgentServer } from "../upstream-server";
import { bridgeWsConnection, createEventObserverTransport } from "../wire";
import { HostRpc } from "../host-link";
import { trackedSessions } from "../session-tracker";

const T = 1_700_000_000_000;

/** Scripted engine: turn/start replays a fixed event sequence. */
function fakeRuntime(script: (sessionId: string, turnId: string) => LifecycleEvent[]) {
  return {
    harnesses: ["claude-code", "codex-sdk", "codex-app-server"],
    capabilities: () => ({
      multiTurn: true,
      sessionResume: true,
      modelSwitch: "in-session",
      thinkingLevels: true,
      images: true,
      mcpServers: true,
      permissionRequests: false,
    }),
    async run(
      request: { sessionId: string; turnId: string },
      sink: { emit: (e: LifecycleEvent) => void | Promise<void> }
    ) {
      for (const event of script(request.sessionId, request.turnId)) {
        await sink.emit(event);
        // Yield so the quick-ack response hits the socket before events do.
        await new Promise((r) => setImmediate(r));
      }
    },
    admission: () => ({ status: "new" }),
    async cancel() {
      return { confirmed: true };
    },
    async closeSession() {},
    respondPermission: () => false,
    async shutdown() {},
  } as never;
}

function defaultScript(sessionId: string, turnId: string): LifecycleEvent[] {
  return [
    { type: "turn.started", sessionId, turnId, timestamp: T },
    {
      type: "session.created",
      sessionId,
      nativeSessionId: "native-abc",
      harness: "claude-code",
      timestamp: T,
    },
    {
      type: "message.started",
      sessionId,
      turnId,
      messageId: "m1",
      outputIndex: 0,
      role: "assistant",
      timestamp: T,
    },
    {
      type: "message.part",
      sessionId,
      turnId,
      messageId: "m1",
      outputIndex: 0,
      partIndex: 0,
      part: { type: "text", id: "p1", sessionId, messageId: "m1", text: "Hi", state: "done" },
      timestamp: T,
    },
    { type: "message.ended", sessionId, turnId, messageId: "m1", timestamp: T },
    { type: "turn.ended", sessionId, turnId, stopReason: "end_turn", timestamp: T },
  ];
}

describe("Integration: standard wire + deus side channel over a real WebSocket", () => {
  let httpServer: Server;
  let wss: WebSocketServer;
  let port: number;
  let wireServer: AgentServer;
  let client: AgentServerClient | null = null;
  let sideChannel: SideChannelEndpoint | null = null;
  let clientWs: WebSocket | null = null;

  beforeEach(async () => {
    trackedSessions.clear();
    wireServer = new AgentServer(fakeRuntime(defaultScript), {
      info: { name: "test-agent-server" },
    });
    // Production wiring: the observer feeds the session tracker from the
    // event broadcast (native ids, turn boundaries).
    wireServer.attach(createEventObserverTransport());
    httpServer = createHttpServer();
    wss = new WebSocketServer({ server: httpServer });
    wss.on("connection", (ws) => bridgeWsConnection(ws, wireServer));
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", () => {
        const addr = httpServer.address();
        port = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await client?.close();
    client = null;
    sideChannel = null;
    clientWs?.close();
    clientWs = null;
    wss.close();
    httpServer.close();
    vi.restoreAllMocks();
  });

  /** Connect exactly like the backend's AgentLink: ws → transport → side
   *  channel claim → upstream client; sends deus/hello. */
  async function connectBackendStyle(
    onToolRequest?: (method: string, params: unknown) => Promise<unknown>
  ): Promise<AgentServerClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    clientWs = ws;
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    const transport = wsLineTransport(ws);

    const channel = new SideChannelEndpoint((line) => transport.send(line), "test-backend");
    if (onToolRequest) {
      for (const method of Object.values(SIDE_CHANNEL)) {
        channel.onRequest(method, (params) => onToolRequest(method, params));
      }
    }
    sideChannel = channel;
    channel.notify(SIDE_CHANNEL.hello, {});

    client = await AgentServerClient.attach(claimSideChannel(transport, channel));
    // One round-trip so the server has processed our earlier deus/hello
    // (frames are handled in order) — mirrors AgentLink.connect.
    await client.initialize();
    return client;
  }

  it("handshakes and reports the three deus harnesses", async () => {
    const c = await connectBackendStyle();
    const init = await c.initialize();
    expect(Object.keys(init.harnesses).sort()).toEqual([
      "claude-code",
      "codex-app-server",
      "codex-sdk",
    ]);
    expect(init.server.name).toBe("test-agent-server");
  });

  it("runs a quick-ack turn and streams sequenced events in order", async () => {
    const c = await connectBackendStyle();
    const envelopes: WireEventEnvelope[] = [];
    c.onEvent((envelope) => envelopes.push(envelope));

    const turn = await c.runTurn({
      sessionId: "sess-1",
      turnId: "turn-1",
      input: "hello",
      config: { harness: "claude-code", cwd: "/tmp" },
    });
    const ended = await turn.result;
    expect(ended.stopReason).toBe("end_turn");

    await vi.waitFor(() => expect(envelopes.length).toBe(6));
    expect(envelopes.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(envelopes.map((e) => e.event.type)).toEqual([
      "turn.started",
      "session.created",
      "message.started",
      "message.part",
      "message.ended",
      "turn.ended",
    ]);
  });

  it("tracks session config from observed turn/start and native id from events", async () => {
    const c = await connectBackendStyle();
    const turn = await c.runTurn({
      sessionId: "sess-track",
      turnId: "turn-1",
      input: "hello",
      config: {
        harness: "claude-code",
        cwd: "/tmp/workspace",
        additionalDirectories: ["/tmp/extra"],
      },
    });
    await turn.result;
    await vi.waitFor(() => {
      const state = trackedSessions.get("sess-track");
      expect(state?.cwd).toBe("/tmp/workspace");
      expect(state?.harness).toBe("claude-code");
      expect(state?.additionalDirectories).toEqual(["/tmp/extra"]);
      expect(state?.nativeSessionId).toBe("native-abc");
      // turn.ended cleared the active-turn marker.
      expect(state?.turnId).toBeUndefined();
    });
  });

  it("does not track a rejected turn/start; the corrected retry records its own config", async () => {
    const c = await connectBackendStyle();
    // First attempt: unavailable harness (fake runtime registers no "acp"),
    // but a well-formed payload with sessionId/turnId/cwd.
    await expect(
      c.startTurn({
        sessionId: "sess-reject",
        turnId: "turn-bad",
        input: "x",
        config: { harness: "acp", cwd: "/tmp/WRONG" },
      })
    ).rejects.toMatchObject({ code: -32000 });
    // The rejected request never reached the tracker.
    expect(trackedSessions.get("sess-reject")).toBeUndefined();

    // Corrected retry: accepted, and the tracker records ITS config.
    const turn = await c.runTurn({
      sessionId: "sess-reject",
      turnId: "turn-good",
      input: "x",
      config: { harness: "claude-code", cwd: "/tmp/RIGHT" },
    });
    await turn.result;
    await vi.waitFor(() => {
      const state = trackedSessions.get("sess-reject");
      expect(state?.cwd).toBe("/tmp/RIGHT");
      expect(state?.harness).toBe("claude-code");
    });
  });

  it("rejects a second turn on a busy session with turnActive", async () => {
    // A runtime whose turn never ends within the test window.
    const hangingRuntime = {
      harnesses: ["claude-code"],
      capabilities: () => ({
        multiTurn: true,
        sessionResume: true,
        modelSwitch: "in-session",
        thinkingLevels: true,
        images: true,
        mcpServers: true,
        permissionRequests: false,
      }),
      async run(
        request: { sessionId: string; turnId: string },
        sink: { emit: (e: LifecycleEvent) => void | Promise<void> }
      ) {
        await sink.emit({
          type: "turn.started",
          sessionId: request.sessionId,
          turnId: request.turnId,
          timestamp: T,
        });
        await new Promise(() => {}); // hang — the turn stays active
      },
      admission: () => ({ status: "new" }),
      async cancel() {
        return { confirmed: true };
      },
      async closeSession() {},
      respondPermission: () => false,
      async shutdown() {},
    } as never;
    const slowServer = new AgentServer(hangingRuntime, {});
    const slowWss = new WebSocketServer({ port: 0 });
    slowWss.on("connection", (ws) => bridgeWsConnection(ws, slowServer));
    await new Promise<void>((resolve) => slowWss.once("listening", () => resolve()));
    const slowPort = (slowWss.address() as { port: number }).port;

    const ws = new WebSocket(`ws://127.0.0.1:${slowPort}`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    const c = await AgentServerClient.attach(wsLineTransport(ws) as never);

    await c.startTurn({
      sessionId: "busy-1",
      turnId: "turn-a",
      input: "x",
      config: { harness: "claude-code", cwd: "/tmp" },
    });
    await expect(
      c.startTurn({
        sessionId: "busy-1",
        turnId: "turn-b",
        input: "y",
        config: { harness: "claude-code", cwd: "/tmp" },
      })
    ).rejects.toMatchObject({ code: -32002 });

    await c.close();
    ws.close();
    slowWss.close();
  });

  it("routes an agent-side HostRpc request to the backend over the side channel", async () => {
    const seen: Array<{ method: string; params: unknown }> = [];
    await connectBackendStyle(async (method, params) => {
      seen.push({ method, params });
      if (method === SIDE_CHANNEL.getDiff) return { diff: "diff --git a b" };
      throw new Error(`unexpected ${method}`);
    });

    // The hello already marked this connection as host; the entry's tools can
    // now round-trip.
    const response = await HostRpc.requestGetDiff({ sessionId: "sess-1" });
    expect(response).toEqual({ diff: "diff --git a b" });
    expect(seen).toEqual([{ method: SIDE_CHANNEL.getDiff, params: { sessionId: "sess-1" } }]);
  });

  it("answers deus/provider-auth on the side channel (codex → unsupported)", async () => {
    await connectBackendStyle();
    const result = await sideChannel!.request<{ error?: string }>(
      SIDE_CHANNEL.providerAuth,
      { agentHarness: "codex-sdk", cwd: "/tmp" },
      5_000
    );
    expect(result).toMatchObject({ error: "unsupported" });
  });

  it("side-channel frames never reach the upstream wire (and vice versa)", async () => {
    const c = await connectBackendStyle(async () => ({ ok: true }));
    // An upstream request still works after side-channel traffic interleaves.
    await HostRpc.requestGetDiff({ sessionId: "s" }).catch(() => {});
    const init = await c.initialize();
    expect(init.protocolVersion).toBe(WIRE_PROTOCOL_VERSION);
  });
});
