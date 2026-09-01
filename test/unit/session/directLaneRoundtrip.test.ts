// An end-to-end proof of the Mac-CLOSED direct lane, wiring the REAL pieces that
// ship — cloudSessionSocket + makeCloudFrameHandler (receive) + the direct send
// registry — against a controllable fake WebSocket. It exercises the whole
// round-trip a running browser would: connect → a snapshot renders the prior
// transcript → a prompt leaves on the wire as agnt's `message.send` → agnt's echo
// and reply fold back into the SAME cache the chat reads. Only the thin React
// effect in `useCloudDirectSession` (which just calls exactly these functions in
// exactly this order) is out of frame, because the suite runs without a DOM.

import { describe, it, expect } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  connectCloudSessionSocket,
  type WebSocketLike,
  type WebSocketLikeMessage,
} from "@/features/session/cloud/cloudSessionSocket";
import { makeCloudFrameHandler } from "@/features/session/cloud/cloudFrameHandler";
import {
  registerDirectSession,
  getDirectSession,
  buildMessageSendFrame,
  buildCancelFrame,
} from "@/features/session/cloud/directSessionRegistry";
import {
  createStreamCursor,
  flushDeltas,
  messagesKey,
  type AgentStreamContext,
  type SessionFold,
} from "@/features/session/lib/agentEventFold";
import type { PaginatedMessages } from "@/features/session/api/session.service";

class MockWs implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  private listeners: Record<string, ((e: WebSocketLikeMessage) => void)[]> = {};
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.emit("close", {});
  }
  addEventListener(type: string, listener: (e: WebSocketLikeMessage) => void) {
    (this.listeners[type] ||= []).push(listener);
  }
  private emit(type: string, event: WebSocketLikeMessage) {
    (this.listeners[type] ?? []).forEach((l) => l(event));
  }
  triggerOpen() {
    this.readyState = 1;
    this.emit("open", {});
  }
  triggerMessage(data: unknown) {
    this.emit("message", { data: typeof data === "string" ? data : JSON.stringify(data) });
  }
}

const T = 1_700_000_000_000;
const textPart = (id: string, sessionId: string, messageId: string, text: string) => ({
  type: "text",
  id,
  sessionId,
  messageId,
  text,
  state: "done",
});

function makeCtx(qc: QueryClient, sessionId: string, folds: Map<string, SessionFold>) {
  const ctx: AgentStreamContext = {
    queryClient: qc,
    activeSessionId: sessionId,
    folds,
    cursor: createStreamCursor(),
    scheduleFlush: () => {
      const fold = folds.get(sessionId);
      if (fold) flushDeltas(qc, sessionId, fold);
    },
    requestRefetch: () => {},
  };
  return ctx;
}

describe("direct lane round-trip (connect → render → send → reply)", () => {
  it("renders a snapshot, sends a prompt on the wire, and folds agnt's reply back in", () => {
    const SESSION = "sess-e2e";
    const PROVIDER = "prov-e2e";
    const qc = new QueryClient();
    qc.setQueryData<PaginatedMessages>(messagesKey(SESSION), {
      messages: [],
      compactions: [],
      has_older: false,
      has_newer: false,
    });

    // Wire the socket → fold, exactly as useCloudDirectSession does.
    const folds = new Map<string, SessionFold>();
    const ctx = makeCtx(qc, SESSION, folds);
    const foldFrame = makeCloudFrameHandler(ctx, SESSION);
    const mock = new MockWs();
    const socket = connectCloudSessionSocket({
      baseUrl: "https://api.agnt",
      providerSessionId: PROVIDER,
      token: "jwt",
      onFrame: foldFrame,
      createWs: () => mock,
    });
    const dispose = registerDirectSession(SESSION, {
      sendMessage: (prompt, turnId, options) =>
        socket.send(buildMessageSendFrame(prompt, turnId, options)),
      cancel: (turnId) => socket.send(buildCancelFrame(turnId)),
    });

    mock.triggerOpen();

    // 1) The reconnect snapshot restores the prior transcript.
    mock.triggerMessage({
      type: "session.snapshot",
      state: { sessionId: PROVIDER, status: "ready", currentTurnId: null, turns: [] },
      messages: [
        {
          id: "m1",
          messageIndex: 0,
          sessionId: PROVIDER,
          turnId: "t1",
          outputIndex: 1,
          role: "user",
          createdAt: T,
          parts: [textPart("p1", PROVIDER, "m1", "earlier question")],
        },
      ],
      events: [],
    });
    expect(JSON.stringify(readMessages(qc, SESSION))).toContain("earlier question");

    // 2) The user sends — the prompt leaves as agnt's `message.send` (no credential).
    getDirectSession(SESSION)!.sendMessage("what is 2+2?", "turn-live", {
      model: "claude-opus-4-8",
      agentHarness: "claude-code",
    });
    const outbound = mock.sent.filter((s) => s !== "ping").map((s) => JSON.parse(s));
    expect(outbound).toContainEqual({
      type: "message.send",
      text: "what is 2+2?",
      turnId: "turn-live",
      idempotencyKey: "turn-live",
      options: { harness: "claude-code", model: "claude-opus-4-8" },
    });

    // 3) agnt admits the turn and streams the reply back over the SAME socket —
    //    the user echo, then the assistant answer, then the turn's end.
    mock.triggerMessage({
      type: "message.started",
      sessionId: PROVIDER,
      turnId: "turn-live",
      messageId: "u-live",
      outputIndex: 2,
      role: "user",
      timestamp: T,
    });
    mock.triggerMessage({
      type: "message.part",
      sessionId: PROVIDER,
      turnId: "turn-live",
      messageId: "u-live",
      outputIndex: 2,
      partIndex: 0,
      part: textPart("pu", PROVIDER, "u-live", "what is 2+2?"),
      timestamp: T,
    });
    mock.triggerMessage({
      type: "message.started",
      sessionId: PROVIDER,
      turnId: "turn-live",
      messageId: "a-live",
      outputIndex: 3,
      role: "assistant",
      timestamp: T,
    });
    mock.triggerMessage({
      type: "message.part",
      sessionId: PROVIDER,
      turnId: "turn-live",
      messageId: "a-live",
      outputIndex: 3,
      partIndex: 0,
      part: textPart("pa", PROVIDER, "a-live", "4"),
      timestamp: T,
    });
    mock.triggerMessage({
      type: "turn.ended",
      sessionId: PROVIDER,
      turnId: "turn-live",
      stopReason: "end_turn",
      timestamp: T,
    });

    const body = JSON.stringify(readMessages(qc, SESSION));
    expect(body).toContain("earlier question"); // history preserved
    expect(body).toContain("4"); // the reply rendered
    // The whole exchange is in ONE cache: prior user + live user echo + assistant.
    expect(readMessages(qc, SESSION)).toHaveLength(3);

    // 4) Stop sends `agent.cancel` on the same wire.
    getDirectSession(SESSION)!.cancel("turn-live");
    expect(mock.sent.map((s) => s).filter((s) => s.includes("agent.cancel"))).toHaveLength(1);

    dispose();
    socket.close();
    expect(getDirectSession(SESSION)).toBeUndefined();
  });
});

function readMessages(qc: QueryClient, sessionId: string) {
  return qc.getQueryData<PaginatedMessages>(messagesKey(sessionId))!.messages;
}
