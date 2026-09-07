import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { SessionSnapshotEventSchema, TurnEndedEventSchema } from "@deus-hq/api";
import { emptyConversation, reduceConversation } from "@zvada/agent-server/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeToAgentEvents } from "@/features/session/hooks/useAgentEvents";
import { messagesKey } from "@/features/session/lib/agentEventFold";
import { createOptimisticUserMessage } from "@/features/session/lib/optimisticMessage";
import { queryKeys } from "@/shared/api/queryKeys";
import {
  projectCloudSnapshot,
  type AgentConversationSnapshot,
} from "@shared/cloud-session-snapshot";
import type { PaginatedMessages } from "@/features/session/api/session.service";
import { isUnknownPart, type LifecycleEvent } from "@shared/protocol-types";
import type { Message, Session } from "@shared/types/session";

// Replace only the transport and browser scheduling. The subscription, lane
// detection, snapshot projection, engine fold and query observers stay real.
const { listeners, warning } = vi.hoisted(() => ({
  listeners: new Set<(name: string, data: unknown) => void>(),
  warning: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { warning, error: vi.fn() } }));
vi.mock("@/platform/ws", () => ({
  onEvent: (listener: (name: string, data: unknown) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  sendRequest: vi.fn(),
  sendMutate: vi.fn(),
  sendCommand: vi.fn(),
}));

const T = Date.parse("2026-09-07T12:00:00Z");
const TURN = "turn-live";
let queryClient: QueryClient;
let stopSubscription: () => void;
let observerCleanups: Array<() => void>;
let frames: Map<number, FrameRequestCallback>;
let storage: Map<string, string>;
let sessionId: string;
let testNumber = 0;

beforeEach(() => {
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
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  observerCleanups = [];
  // The production cursor outlives the shell, so each test owns a session log.
  sessionId = `subscription-${++testNumber}`;
  stopSubscription = subscribeToAgentEvents(queryClient);
});

afterEach(() => {
  observerCleanups.forEach((cleanup) => cleanup());
  // Exercise removal while the listener is attached; do not leave module folds
  // behind for a later subscription to discover and prune.
  queryClient.clear();
  stopSubscription();
  expect(listeners.size).toBe(0);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function emit(name: string, data: unknown): void {
  for (const listener of listeners) listener(name, data);
}

function flushFrame(): void {
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach((callback) => callback(T));
}

function page(messages: Message[] = []): PaginatedMessages {
  return { messages, compactions: [], has_older: false, has_newer: false };
}

function cached(): PaginatedMessages {
  return queryClient.getQueryData<PaginatedMessages>(messagesKey(sessionId))!;
}

function message(id: string, text: string): Message {
  return {
    id,
    session_id: sessionId,
    seq: 1,
    role: "assistant",
    turn_id: TURN,
    parts: [{ type: "text", id: `part-${id}`, sessionId, messageId: id, text }],
  };
}

function text(id = "answer"): string | undefined {
  const part = cached().messages.find((row) => row.id === id)?.parts?.[0];
  return part && !isUnknownPart(part) && part.type === "text" ? part.text : undefined;
}

function observe(queryFn: () => Promise<PaginatedMessages>, enabled = true) {
  const observer = new QueryObserver(queryClient, {
    queryKey: messagesKey(sessionId),
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

function snapshot(text = "Recovered", seq = 40): AgentConversationSnapshot {
  const projected = projectCloudSnapshot(
    SessionSnapshotEventSchema.parse({
      type: "session.snapshot",
      state: {
        sessionId,
        organizationId: "org",
        workspaceId: "workspace",
        status: "ready",
        currentTurnId: TURN,
      },
      messages: [
        {
          id: "answer",
          sessionId,
          turnId: TURN,
          messageIndex: 0,
          outputIndex: 1,
          role: "assistant",
          createdAt: T,
          parts: message("answer", text).parts,
        },
      ],
    })
  );
  return {
    sessionId,
    seq,
    conversation: projected.events.reduce(reduceConversation, emptyConversation()),
    messageIds: projected.messageIds,
  };
}

function envelope(seq: number, event: LifecycleEvent): void {
  emit("agent:event", { sessionId, seq, event });
}

function delta(seq: number, text: string): void {
  envelope(seq, {
    type: "message.part.delta",
    sessionId,
    turnId: TURN,
    messageId: "answer",
    partId: "part-answer",
    outputIndex: 1,
    partIndex: 0,
    delta: { type: "text", text },
    timestamp: T,
  });
}

describe("shell agent stream subscription", () => {
  it("warns once for a live cloud save failure even when its chat is not open", () => {
    const event = TurnEndedEventSchema.parse({
      type: "turn.ended",
      sessionId,
      turnId: TURN,
      stopReason: "end_turn",
      timestamp: T,
      gitSync: { committed: true, pushed: false, error: "GitHub rejected the push" },
    });
    envelope(1, event);
    envelope(1, event);

    expect(warning).toHaveBeenCalledExactlyOnceWith("Cloud autosave failed", {
      description: "GitHub rejected the push",
      id: `cloud-autosave-${sessionId}-${TURN}`,
      duration: 10_000,
      closeButton: true,
    });
    expect(queryClient.getQueryData(queryKeys.sessions.detail(sessionId))).toBeUndefined();
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

    emit("agent:snapshot", snapshot());
    expect(text()).toBe("Recovered");
    expect(cached().messages).toContainEqual(older);
    expect(cached().messages.at(-1)).toEqual(pending);

    delta(41, " while hidden");
    expect(frames.size).toBe(0);
    expect(text()).toBe("Recovered");

    const observer = observe(queryFn);
    expect(observer.getCurrentResult().data).toBe(cached());
    delta(42, " and visible");
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

    emit("agent:snapshot", snapshot("Backend history"));
    delta(41, " backend delta");
    envelope(
      42,
      TurnEndedEventSchema.parse({
        type: "turn.ended",
        sessionId,
        turnId: TURN,
        stopReason: "end_turn",
        timestamp: T,
        gitSync: { committed: true, pushed: false, error: "Ignored backend save" },
      })
    );
    flushFrame();
    await vi.advanceTimersByTimeAsync(250);

    expect(cached()).toBe(before);
    expect(frames.size).toBe(0);
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(warning).not.toHaveBeenCalled();
  });

  it("ignores queued deltas and gap refetches after the session switches to direct", async () => {
    storage.set("deus.cloudDirect", "1");
    setLane(false);
    const queryFn = vi.fn(async () => page([message("answer", "Backend page")]));
    await queryClient.fetchQuery({ queryKey: messagesKey(sessionId), queryFn });
    observe(queryFn);
    emit("agent:snapshot", snapshot());
    delta(41, " queued");
    delta(43, " across a gap");
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
    emit("agent:snapshot", snapshot("Discarded history"));
    delta(41, " queued");

    observerCleanups.pop()!();
    queryClient.removeQueries({ queryKey: messagesKey(sessionId), exact: true });
    await queryClient.fetchQuery({ queryKey: messagesKey(sessionId), queryFn });
    observe(queryFn);
    flushFrame();
    expect(cached().messages).toEqual([]);

    envelope(42, {
      type: "message.started",
      sessionId,
      turnId: TURN,
      messageId: "answer",
      outputIndex: 1,
      role: "assistant",
      timestamp: T,
    });
    envelope(43, {
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
