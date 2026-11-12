import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { SessionSnapshotEventSchema, TurnEndedEventSchema } from "@deus-hq/api";
import { emptyConversation, reduceConversation } from "@zvada/agent-server/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeToAgentEvents } from "@/features/session/hooks/useAgentEvents";
import { RuntimeClient } from "@/platform/ws/runtime-client";
import { messagesKey } from "@/features/session/lib/agentEventFold";
import { createOptimisticUserMessage } from "@/features/session/lib/optimisticMessage";
import { queryKeys } from "@/shared/api/queryKeys";
import type { SessionEvent } from "@shared/api/sessions";
import { scopeMatches } from "@shared/api/stream";
import {
  projectCloudSnapshot,
  type AgentConversationSnapshot,
} from "@shared/cloud-session-snapshot";
import type { PaginatedMessages } from "@shared/types/session";
import { isLiveOnlyEvent, isUnknownPart, type LifecycleEvent } from "@shared/protocol-types";
import type { Message, Session } from "@shared/types/session";

// Replace only the socket and browser scheduling. The runtime client, the
// subscription, lane detection, snapshot projection, engine fold and query
// observers stay real.
const { warning } = vi.hoisted(() => ({ warning: vi.fn() }));
vi.mock("sonner", () => ({ toast: { warning, error: vi.fn() } }));
vi.mock("@/platform/ws", () => ({
  // Every cache here belongs to a runtime, and that is the one its chats are followed on.
  getRuntimeClient: () => {
    throw new Error("No runtime is selected app-wide in this test");
  },
  call: vi.fn(),
}));

/** One connection, seen from the host: what the client sent, and a way to answer it. */
class HostSocket {
  readyState = 1;
  readonly sent: Array<Record<string, unknown>> = [];
  /** What the host does with a frame from the client. */
  onFrame: (frame: Record<string, unknown>) => void = () => {};
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  addEventListener(type: string, listener: (event: never) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener as (event: unknown) => void);
    this.listeners.set(type, listeners);
  }
  send(raw: string): void {
    const frame = JSON.parse(raw);
    this.sent.push(frame);
    this.onFrame(frame);
  }
  close(): void {
    this.readyState = 3;
  }
  /** A frame from the host. */
  deliver(frame: Record<string, unknown>): void {
    this.emit("message", { data: JSON.stringify(frame) });
  }
  /** The connection is lost. */
  lose(): void {
    this.readyState = 3;
    this.emit("close", { code: 1006, reason: "" });
  }
  private emit(type: string, event: unknown): void {
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }
}

/** Where the host starts numbering a chat's kept events: its own count, not the engine's `seq`. */
const FIRST_NUMBER = 7_000;

/**
 * A runtime with its own cache, and the host at the other end of its socket.
 * The host publishes the way the backend's streams do: an event reaches the
 * subscriptions its chat matches, kept events are numbered per chat, and one
 * that is not kept (a token delta) carries the number of the kept one before it.
 */
function createHost(name = "host") {
  const sockets: HostSocket[] = [];
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  const runtime = new RuntimeClient(
    { host: name, account: "account", grant: name },
    {
      queryClient: cache,
      heartbeatIntervalMs: 0,
      retryMs: 1,
      random: () => 0.5,
      open: () => {
        const socket = new HostSocket();
        // The host acknowledges a chat's subscription with where the chat stands.
        socket.onFrame = (frame) => {
          const chat = (frame.params as { sessionId?: string } | undefined)?.sessionId;
          if (frame.type !== "q:subscribe" || frame.resource !== "sessionEvents" || !chat) return;
          socket.deliver({
            type: "q:subscribed",
            id: frame.id,
            seq: numbers.get(chat) ?? FIRST_NUMBER,
          });
        };
        sockets.push(socket);
        return socket;
      },
    }
  );
  const numbers = new Map<string, number>();
  const socket = () => sockets.at(-1)!;
  /** The `sessionEvents` subscriptions the current connection holds. */
  const subscriptions = () => {
    const sent = sockets.at(-1)?.sent ?? [];
    const stopped = new Set(
      sent.filter((frame) => frame.type === "q:unsubscribe").map((frame) => frame.id)
    );
    return sent.filter(
      (frame) =>
        frame.type === "q:subscribe" && frame.resource === "sessionEvents" && !stopped.has(frame.id)
    );
  };
  const filterOf = (subscription: Record<string, unknown>) =>
    (subscription.params ?? {}) as Record<string, unknown>;
  return {
    runtime,
    cache,
    subscriptions,
    /** Every frame of one type the current connection has received from the client. */
    sent: (type: string) => socket().sent.filter((frame) => frame.type === type),
    async connect(): Promise<void> {
      const ready = runtime.connect();
      await vi.advanceTimersByTimeAsync(0);
      socket().deliver({ type: "connected" });
      await ready;
    },
    drop(): void {
      socket().lose();
    },
    /** The client redials after a drop, and the host admits it again. */
    async comeBack(): Promise<void> {
      const before = sockets.length;
      await vi.advanceTimersByTimeAsync(2);
      expect(sockets).toHaveLength(before + 1);
      socket().deliver({ type: "connected" });
    },
    /** The number of the last kept event the host published for a chat. */
    position: (chat: string) => numbers.get(chat) ?? FIRST_NUMBER,
    publish(chat: string, update: SessionEvent, keep = true): void {
      const number = (numbers.get(chat) ?? FIRST_NUMBER) + (keep ? 1 : 0);
      numbers.set(chat, number);
      for (const subscription of subscriptions()) {
        const filter = filterOf(subscription);
        if (!scopeMatches(filter, { sessionId: chat })) continue;
        socket().deliver({
          type: "q:event",
          id: subscription.id,
          event: "sessionEvents",
          data: update,
          // Only a subscription to one chat can make sense of that chat's numbers.
          ...(filter.sessionId !== undefined ? { seq: number } : {}),
        });
      }
    },
    /** The host publishes on a stream with no scope: every subscription to it hears. */
    tell(stream: string, data: unknown): void {
      const stopped = new Set(
        socket()
          .sent.filter((frame) => frame.type === "q:unsubscribe")
          .map((frame) => frame.id)
      );
      for (const frame of socket().sent) {
        if (frame.type !== "q:subscribe" || frame.resource !== stream || stopped.has(frame.id))
          continue;
        socket().deliver({ type: "q:event", id: frame.id, event: stream, data });
      }
    },
    /** The host cannot say what a returning subscriber missed, only where the chat stands. */
    reset(chat: string): void {
      for (const subscription of subscriptions()) {
        if (filterOf(subscription).sessionId !== chat) continue;
        socket().deliver({ type: "q:reset", id: subscription.id, seq: numbers.get(chat) });
      }
    },
  };
}
type Host = ReturnType<typeof createHost>;

const T = Date.parse("2026-09-07T12:00:00Z");
const TURN = "turn-live";
let host: Host;
let queryClient: QueryClient;
let stopSubscription: () => void;
let observerCleanups: Array<() => void>;
let frames: Map<number, FrameRequestCallback>;
let storage: Map<string, string>;
let engineSeq: Map<string, number>;
let sessionId: string;
let testNumber = 0;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(T);
  vi.stubEnv("VITE_CLOUD_DIRECT", "0");
  storage = new Map();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null });
  frames = new Map();
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  host = createHost();
  queryClient = host.cache;
  observerCleanups = [];
  engineSeq = new Map();
  sessionId = `subscription-${++testNumber}`;
  stopSubscription = subscribeToAgentEvents(queryClient);
  await host.connect();
});

afterEach(() => {
  observerCleanups.forEach((cleanup) => cleanup());
  // Exercise removal while the chats are followed; do not leave folds behind
  // for a later subscription to discover and prune.
  queryClient.clear();
  stopSubscription();
  expect(host.subscriptions()).toEqual([]);
  host.runtime.dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function flushFrame(): void {
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach((callback) => callback(T));
}

function page(messages: Message[] = []): PaginatedMessages {
  return {
    turns: [],
    messages,
    compactions: [],
    has_older: false,
    has_newer: false,
  };
}

function cached(chat = sessionId): PaginatedMessages {
  return queryClient.getQueryData<PaginatedMessages>(messagesKey(chat))!;
}

function message(id: string, text: string, chat = sessionId): Message {
  return {
    id,
    session_id: chat,
    seq: 1,
    role: "assistant",
    turn_id: TURN,
    parts: [{ type: "text", id: `part-${id}`, sessionId: chat, messageId: id, text }],
  };
}

function text(id = "answer", chat = sessionId): string | undefined {
  const part = cached(chat).messages.find((row) => row.id === id)?.parts?.[0];
  return part && !isUnknownPart(part) && part.type === "text" ? part.text : undefined;
}

function observe(queryFn: () => Promise<PaginatedMessages>, enabled = true, chat = sessionId) {
  const observer = new QueryObserver(queryClient, {
    queryKey: messagesKey(chat),
    queryFn,
    enabled,
    staleTime: Infinity,
  });
  observerCleanups.push(observer.subscribe(() => {}));
  return observer;
}

function setLane(direct: boolean): void {
  queryClient.setQueryData<Session>(queryKeys.sessions.detail(sessionId), {
    id: sessionId,
    workspace_id: "workspace",
    workspace_kind: "cloud",
    provider_session_id: direct ? "agnt-session" : null,
    agent_harness: "claude-code",
    status: "working",
    message_count: 1,
    context_token_count: 0,
    context_used_percent: 0,
    is_hidden: false,
    updated_at: new Date(T).toISOString(),
  });
}

function snapshot(text = "Recovered", chat = sessionId): AgentConversationSnapshot {
  const projected = projectCloudSnapshot(
    SessionSnapshotEventSchema.parse({
      type: "session.snapshot",
      state: {
        sessionId: chat,
        organizationId: "org",
        workspaceId: "workspace",
        status: "ready",
        currentTurnId: TURN,
      },
      messages: [
        {
          id: "answer",
          sessionId: chat,
          turnId: TURN,
          messageIndex: 0,
          outputIndex: 1,
          role: "assistant",
          createdAt: T,
          parts: message("answer", text, chat).parts,
        },
      ],
    })
  );
  return {
    sessionId: chat,
    conversation: projected.events.reduce(reduceConversation, emptyConversation()),
    messageIds: projected.messageIds,
  };
}

/** The host restates a chat, as it does once a cloud chat's history is restored. */
function restate(text?: string, chat = sessionId, from = host): void {
  from.publish(chat, { type: "snapshot", snapshot: snapshot(text, chat) });
}

/** The host passes on one engine event, in the engine's envelope (its own `seq` rides along). */
function envelope(event: LifecycleEvent, chat = sessionId, from = host): void {
  const kept = !isLiveOnlyEvent(event);
  const seq = (engineSeq.get(chat) ?? 0) + (kept ? 1 : 0);
  engineSeq.set(chat, seq);
  from.publish(chat, { type: "event", envelope: { sessionId: chat, seq, event } }, kept);
}

function delta(text: string, chat = sessionId, from = host): void {
  envelope(
    {
      type: "message.part.delta",
      sessionId: chat,
      turnId: TURN,
      messageId: "answer",
      partId: "part-answer",
      outputIndex: 1,
      partIndex: 0,
      delta: { type: "text", text },
      timestamp: T,
    },
    chat,
    from
  );
}

function started(chat = sessionId): LifecycleEvent {
  return {
    type: "message.started",
    sessionId: chat,
    turnId: TURN,
    messageId: "answer",
    outputIndex: 1,
    role: "assistant",
    timestamp: T,
  };
}

function saveFailed(error = "GitHub rejected the push"): LifecycleEvent {
  return TurnEndedEventSchema.parse({
    type: "turn.ended",
    sessionId,
    turnId: TURN,
    stopReason: "end_turn",
    timestamp: T,
    gitSync: { committed: true, pushed: false, error },
  }) as LifecycleEvent;
}

const saveWarning = () =>
  [
    "Cloud autosave failed",
    {
      description: "GitHub rejected the push",
      id: `cloud-autosave-${sessionId}-${TURN}`,
      duration: 10_000,
      closeButton: true,
    },
  ] as const;

describe("shell agent stream subscription", () => {
  describe("which chats it follows", () => {
    it("follows a chat while the cache holds its message page", () => {
      expect(host.subscriptions()).toEqual([]);

      queryClient.setQueryData(messagesKey(sessionId), page());
      const [subscription] = host.subscriptions();
      expect(host.subscriptions()).toEqual([
        {
          type: "q:subscribe",
          id: subscription.id,
          resource: "sessionEvents",
          params: { sessionId },
        },
      ]);

      // The page changing is not a second chat.
      queryClient.setQueryData(messagesKey(sessionId), page([message("answer", "Loaded")]));
      observe(async () => page());
      expect(host.subscriptions()).toHaveLength(1);

      observerCleanups.pop()!();
      queryClient.removeQueries({ queryKey: messagesKey(sessionId), exact: true });
      expect(host.subscriptions()).toEqual([]);
      expect(host.sent("q:unsubscribe")).toEqual([{ type: "q:unsubscribe", id: subscription.id }]);
    });

    it("follows the chats whose pages were cached before it started", async () => {
      const late = createHost("late");
      late.cache.setQueryData(messagesKey("first"), page());
      late.cache.setQueryData(messagesKey("second"), page());
      const stop = subscribeToAgentEvents(late.cache);
      try {
        await late.connect();
        expect(late.subscriptions().map((subscription) => subscription.params)).toEqual([
          { sessionId: "first" },
          { sessionId: "second" },
        ]);
      } finally {
        stop();
        late.runtime.dispose();
      }
    });

    it("follows nothing for a chat with no message page", () => {
      // The chat is known here (its row, its workspace's tabs) but nobody has opened it.
      setLane(false);
      queryClient.setQueryData(queryKeys.sessions.byWorkspace("workspace"), []);
      // What a panel with no chat selected leaves in the cache: a page of no chat.
      queryClient.setQueryData(messagesKey(""), page());

      expect(host.subscriptions()).toEqual([]);
    });
  });

  describe("when the connection returns", () => {
    it("keeps streaming an open part after the runtime reconnects", async () => {
      queryClient.setQueryData(messagesKey(sessionId), page([message("answer", "initial")]));
      const queryFn = vi.fn(async () => page([message("answer", "Stored")]));
      observe(queryFn);
      restate("Streaming");
      delta(" so far");
      flushFrame();
      expect(text()).toBe("Streaming so far");

      // A relay blip: the socket drops and comes back, and the stream resumes.
      host.drop();
      expect(host.runtime.isConnected()).toBe(false);
      await host.comeBack();
      delta(" and more");
      flushFrame();
      expect(text()).toBe("Streaming so far and more");
      await vi.advanceTimersByTimeAsync(250);
      expect(queryFn).not.toHaveBeenCalled();
    });

    it("resumes each chat after the last event it received, and reads no page again", async () => {
      const other = `${sessionId}-other`;
      const read = vi.fn(async () => page());
      const readOther = vi.fn(async () => page());
      await queryClient.fetchQuery({ queryKey: messagesKey(sessionId), queryFn: read });
      await queryClient.fetchQuery({ queryKey: messagesKey(other), queryFn: readOther });
      envelope(started());
      envelope(started(other), other);
      envelope(
        {
          type: "message.part",
          sessionId: other,
          turnId: TURN,
          messageId: "answer",
          outputIndex: 1,
          partIndex: 0,
          part: {
            type: "text",
            id: "part-answer",
            sessionId: other,
            messageId: "answer",
            text: "",
          },
          timestamp: T,
        },
        other
      );

      host.drop();
      await host.comeBack();

      expect(host.subscriptions().map(({ params, after }) => ({ params, after }))).toEqual([
        { params: { sessionId }, after: FIRST_NUMBER + 1 },
        { params: { sessionId: other }, after: FIRST_NUMBER + 2 },
      ]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(read).toHaveBeenCalledTimes(1);
      expect(readOther).toHaveBeenCalledTimes(1);
    });

    it("returns to a chat nothing arrived on where the host said it stood, and reads no page again", async () => {
      const busy = `${sessionId}-busy`;
      const readQuiet = vi.fn(async () => page());
      const readBusy = vi.fn(async () => page());
      await queryClient.fetchQuery({ queryKey: messagesKey(sessionId), queryFn: readQuiet });
      await queryClient.fetchQuery({ queryKey: messagesKey(busy), queryFn: readBusy });
      envelope(started(busy), busy);

      host.drop();
      await host.comeBack();

      expect(host.subscriptions().map(({ params, after }) => ({ params, after }))).toEqual([
        { params: { sessionId }, after: host.position(sessionId) },
        { params: { sessionId: busy }, after: host.position(busy) },
      ]);
      await vi.advanceTimersByTimeAsync(250);
      expect(readQuiet).toHaveBeenCalledTimes(1);
      expect(readBusy).toHaveBeenCalledTimes(1);
    });

    it("drops the fold and reads the page again, once, for the one chat the host cannot resume", async () => {
      const other = `${sessionId}-other`;
      const read = vi.fn(async () => page([message("answer", "Read again")]));
      const readOther = vi.fn(async () => page([message("answer", "Other page", other)]));
      await queryClient.fetchQuery({ queryKey: messagesKey(sessionId), queryFn: read });
      await queryClient.fetchQuery({ queryKey: messagesKey(other), queryFn: readOther });
      observe(read);
      observe(readOther, true, other);
      restate("Streaming");
      restate("Other", other);
      delta(" so far");
      flushFrame();
      expect(text()).toBe("Streaming so far");

      // Twice in quick succession the host returns unable to say what this chat missed.
      for (let attempt = 0; attempt < 2; attempt++) {
        host.drop();
        await host.comeBack();
        host.reset(sessionId);
      }
      expect(read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(250);
      expect(read).toHaveBeenCalledTimes(2);
      expect(readOther).toHaveBeenCalledTimes(1);
      expect(text()).toBe("Read again");

      // What was folded before the reset went with it: a late delta for that
      // part cannot write the old text back over the page just read.
      delta(" late");
      flushFrame();
      expect(text()).toBe("Read again");
      // The other chat's fold is where it was.
      delta(" continues", other);
      flushFrame();
      expect(text("answer", other)).toBe("Other continues");
    });
  });

  it("takes a snapshot as the chat restated, and drops the read a reset had asked for", async () => {
    const queryFn = vi.fn(async () => page([message("answer", "Stored")]));
    await queryClient.fetchQuery({ queryKey: messagesKey(sessionId), queryFn });
    observe(queryFn);
    // Back with nothing to resume from: the page is to be read again.
    host.drop();
    await host.comeBack();

    restate("Restated by the host");

    expect(text()).toBe("Restated by the host");
    await vi.advanceTimersByTimeAsync(250);
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(text()).toBe("Restated by the host");
  });

  it("keeps folds separate for hosts with identical session and message IDs", async () => {
    const hosts = ["A", "B"].map((name) => createHost(name));
    const stops = hosts.map(({ runtime, cache }) => {
      cache.setQueryData(messagesKey(sessionId), page([message("answer", "initial")]));
      const observer = new QueryObserver(cache, {
        queryKey: messagesKey(sessionId),
        queryFn: async () => page(),
        staleTime: Infinity,
      });
      const stopObserver = observer.subscribe(() => {});
      const stopEvents = subscribeToAgentEvents(cache);
      return () => {
        stopEvents();
        stopObserver();
        runtime.dispose();
      };
    });
    try {
      for (const each of hosts) {
        await each.connect();
        restate(each.runtime.identity.host, sessionId, each);
        delta(` from ${each.runtime.identity.host}`, sessionId, each);
      }
      flushFrame();
      const content = ({ cache }: Host) =>
        cache.getQueryData<PaginatedMessages>(messagesKey(sessionId))!.messages[0].parts?.[0];
      expect(content(hosts[0])).toMatchObject({ text: "A from A" });
      expect(content(hosts[1])).toMatchObject({ text: "B from B" });
      hosts[0].runtime.dispose();
      restate("late A", sessionId, hosts[0]);
      expect(hosts[0].cache.getQueryData(messagesKey(sessionId))).toBeUndefined();
      expect(content(hosts[1])).toMatchObject({ text: "B from B" });
    } finally {
      stops.forEach((stop) => stop());
    }
  });

  it("warns about a cloud save failure whichever chats this window has open", () => {
    // Nothing of this chat is cached: this window never opened it.
    host.tell("cloudSaveFailures", {
      sessionId,
      turnId: TURN,
      error: "GitHub rejected the push",
    });

    expect(warning).toHaveBeenCalledExactlyOnceWith(...saveWarning());
    expect(queryClient.getQueryData(queryKeys.sessions.detail(sessionId))).toBeUndefined();
  });

  it("leaves the warning to the host: a turn's end on a followed chat does not warn again", async () => {
    await queryClient.fetchQuery({ queryKey: messagesKey(sessionId), queryFn: async () => page() });

    envelope(saveFailed());

    expect(warning).not.toHaveBeenCalled();
  });

  it("restores an unobserved cached page and streams on reopening without a refetch", async () => {
    const older = message("older", "Already loaded history");
    const pending = createOptimisticUserMessage({
      sessionId,
      turnId: "pending-turn",
      content: "Keep my pending prompt",
    });
    const queryFn = vi.fn(async () => page([older, message("answer", "Stale"), pending]));
    await queryClient.fetchQuery({ queryKey: messagesKey(sessionId), queryFn });
    expect(
      queryClient
        .getQueryCache()
        .find({ queryKey: messagesKey(sessionId) })!
        .getObserversCount()
    ).toBe(0);

    restate();
    expect(text()).toBe("Recovered");
    expect(cached().messages).toContainEqual(older);
    expect(cached().messages.at(-1)).toEqual(pending);

    delta(" while hidden");
    expect(frames.size).toBe(0);
    expect(text()).toBe("Recovered");

    const observer = observe(queryFn);
    expect(observer.getCurrentResult().data).toBe(cached());
    delta(" and visible");
    expect(frames.size).toBe(1);
    flushFrame();
    expect(text()).toBe("Recovered while hidden and visible");
    expect(observer.getCurrentResult().data).toBe(cached());
    await vi.advanceTimersByTimeAsync(250);
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it.each(["direct", "unknown"])("ignores backend frames for an observed %s lane", async (lane) => {
    storage.set("deus.cloudDirect", "1");
    if (lane === "direct") setLane(true);
    const queryFn = vi.fn(async () => page([message("answer", "Owned by direct")]));
    await queryClient.fetchQuery({ queryKey: messagesKey(sessionId), queryFn });
    // useMessages retains a disabled observer for both lanes.
    observe(queryFn, false);
    const before = cached();
    // The page is in the cache, so the chat is followed and the frames do arrive.
    expect(host.subscriptions()).toHaveLength(1);

    restate("Backend history");
    delta(" backend delta");
    envelope(saveFailed("Ignored backend save"));
    // Nor is a page read again for it when the connection returns.
    host.drop();
    await host.comeBack();
    host.reset(sessionId);
    flushFrame();
    await vi.advanceTimersByTimeAsync(250);

    expect(cached()).toBe(before);
    expect(frames.size).toBe(0);
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(warning).not.toHaveBeenCalled();
  });

  it("ignores queued deltas and a reset's refetch after the session switches to direct", async () => {
    storage.set("deus.cloudDirect", "1");
    setLane(false);
    const queryFn = vi.fn(async () => page([message("answer", "Backend page")]));
    await queryClient.fetchQuery({ queryKey: messagesKey(sessionId), queryFn });
    observe(queryFn);
    // Back with nothing to resume from: the page is to be read again shortly.
    host.drop();
    await host.comeBack();
    envelope(started());
    envelope({
      type: "message.part",
      sessionId,
      turnId: TURN,
      messageId: "answer",
      outputIndex: 1,
      partIndex: 0,
      part: { type: "text", id: "part-answer", sessionId, messageId: "answer", text: "Recovered" },
      timestamp: T,
    });
    delta(" queued");
    expect(frames.size).toBe(1);

    setLane(true);
    queryClient.setQueryData(
      messagesKey(sessionId),
      page([message("answer", "Direct transcript")])
    );
    const directPage = cached();
    flushFrame();
    expect(cached()).toBe(directPage);
    await vi.advanceTimersByTimeAsync(250);
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(cached()).toBe(directPage);
  });

  it("discards a removed page's fold and pending flush before the same session is reopened", async () => {
    const queryFn = vi.fn(async () => page());
    await queryClient.fetchQuery({ queryKey: messagesKey(sessionId), queryFn });
    observe(queryFn);
    restate("Discarded history");
    delta(" queued");

    observerCleanups.pop()!();
    queryClient.removeQueries({ queryKey: messagesKey(sessionId), exact: true });
    await queryClient.fetchQuery({ queryKey: messagesKey(sessionId), queryFn });
    observe(queryFn);
    flushFrame();
    expect(cached().messages).toEqual([]);

    envelope(started());
    envelope({
      type: "message.part",
      sessionId,
      turnId: TURN,
      messageId: "answer",
      outputIndex: 1,
      partIndex: 0,
      part: { type: "text", id: "new-part", sessionId, messageId: "answer", text: "New content" },
      timestamp: T,
    });
    expect(cached().messages).toHaveLength(1);
    expect(cached().messages[0].parts).toEqual([
      { type: "text", id: "new-part", sessionId, messageId: "answer", text: "New content" },
    ]);
  });
});
