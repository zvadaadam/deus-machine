import { describe, expect, it } from "vitest";
import { emptyConversation, reduceConversationWithChanges } from "@zvada/agent-server/protocol";
import type { ConversationState, DecodedWireEventEnvelope } from "@shared/protocol-types";
import { OpenParts } from "../../../src/services/agent/open-parts";

const SESSION = "chat";
const T = Date.parse("2026-11-12T12:00:00Z");

/** A chat as the event handler holds it: the fold of every envelope, and its open parts. */
function chat() {
  const typing = new OpenParts();
  let conversation: ConversationState = emptyConversation();
  let seq = 0;
  const feed = (event: Record<string, unknown>, live = false) => {
    const kept = !live && event.type !== "message.part.delta";
    if (kept) seq++;
    const envelope = {
      sessionId: SESSION,
      seq,
      ...(live ? { live: true } : {}),
      event: { sessionId: SESSION, turnId: "turn", timestamp: T, ...event },
    } as DecodedWireEventEnvelope;
    conversation = reduceConversationWithChanges(conversation, envelope.event).state;
    typing.saw(envelope);
  };
  const part = (id: string, text: string, state: "streaming" | "done") => ({
    type: "message.part",
    messageId: "answer",
    outputIndex: 1,
    partIndex: 0,
    part: { type: "text", id, text, state },
  });
  const delta = (partId: string, text: string) => ({
    type: "message.part.delta",
    messageId: "answer",
    outputIndex: 1,
    partIndex: 0,
    partId,
    delta: { type: "text", text },
  });
  return {
    feed,
    part,
    delta,
    /** What a subscriber would be sent first: [part id, text so far, seq, live]. */
    opening: () =>
      typing.of(SESSION, conversation).map((frame) => {
        if (frame.type !== "event") throw new Error("an open part is an event");
        const { envelope } = frame;
        const event = envelope.event as { part: { id: string; text: string } };
        return [event.part.id, event.part.text, envelope.seq, envelope.live];
      }),
    forget: () => (conversation = emptyConversation()),
  };
}

describe("open parts", () => {
  it("restates a part still being typed with everything streamed into it so far", () => {
    const c = chat();
    expect(c.opening()).toEqual([]);

    c.feed({ type: "message.started", messageId: "answer", outputIndex: 1, role: "assistant" });
    c.feed(c.part("p1", "", "streaming"));
    c.feed(c.delta("p1", "Hello"));
    c.feed(c.delta("p1", ", world"));

    // As a live frame, under the number of the chat's last kept event.
    expect(c.opening()).toEqual([["p1", "Hello, world", 2, true]]);
  });

  it("says nothing of a part once its kept snapshot closed it", () => {
    const c = chat();
    c.feed(c.part("p1", "", "streaming"));
    c.feed(c.delta("p1", "Hello"));
    c.feed(c.part("p1", "Hello.", "done"));
    expect(c.opening()).toEqual([]);

    // The next one opens on its own.
    c.feed(c.part("p2", "", "streaming"));
    c.feed(c.delta("p2", "More"));
    expect(c.opening()).toEqual([["p2", "More", 3, true]]);
  });

  it("closes what a turn left open when the turn ends, and forgets an ended session", () => {
    const c = chat();
    c.feed(c.part("p1", "", "streaming"));
    c.feed({ type: "turn.ended", stopReason: "cancelled" });
    expect(c.opening()).toEqual([]);

    c.feed({ ...c.part("p2", "", "streaming"), turnId: "next" });
    c.feed({ type: "session.ended", reason: "completed" });
    expect(c.opening()).toEqual([]);
  });

  it("is not opened by a part the engine restated live, and not sent one the fold no longer holds", () => {
    const c = chat();
    // An open part sent to the backend after its own subscription is not a kept snapshot.
    c.feed(c.part("p1", "so far", "streaming"), true);
    expect(c.opening()).toEqual([]);

    c.feed(c.part("p2", "", "streaming"));
    // A restored transcript replaced the fold: nothing of the part is there to restate.
    c.forget();
    expect(c.opening()).toEqual([]);
  });
});
