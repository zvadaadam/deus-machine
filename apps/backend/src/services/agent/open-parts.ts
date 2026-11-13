// backend/src/services/agent/open-parts.ts
// The parts of each chat still being typed.
//
// A kept `message.part` opens a part (text or reasoning streaming, a tool whose
// input is still arriving); token deltas then extend it without being kept. A
// client that starts following a chat, or returns to one, is sent each open
// part as it stands: it shows the whole reply so far, not the part's last kept
// snapshot plus whichever deltas it happens to catch. The engine does the same
// for its own subscribers.

import type { SessionEvent } from "@shared/api/sessions";
import { findConversationMessage, isOpenPart as isOpen } from "@shared/conversation-rows";
import {
  isLiveEnvelope,
  isUnknownEvent,
  type AnyLifecycleEvent,
  type ConversationState,
  type DecodedMessagePartEvent,
  type DecodedWireEventEnvelope,
} from "@shared/protocol-types";

interface Chat {
  /** The engine's number of the chat's last kept event: what a live frame carries. */
  seq: number;
  /** The event that opened each part, by part id. */
  opened: Map<string, DecodedMessagePartEvent>;
}

export class OpenParts {
  private readonly chats = new Map<string, Chat>();

  /** An envelope of a chat, in the order the engine sent them. */
  saw(envelope: DecodedWireEventEnvelope): void {
    const { sessionId, event } = envelope;
    if (isLiveEnvelope(envelope) || isUnknownEvent(event)) return;
    if (event.type === "session.ended") {
      this.chats.delete(sessionId);
      return;
    }
    let chat = this.chats.get(sessionId);
    if (!chat) this.chats.set(sessionId, (chat = { seq: envelope.seq, opened: new Map() }));
    chat.seq = envelope.seq;
    if (event.type === "message.part") {
      if (isOpen(event.part)) chat.opened.set(event.part.id, event);
      else chat.opened.delete(event.part.id);
    } else if (event.type === "turn.ended") {
      for (const [partId, opened] of chat.opened) {
        if (opened.turnId === event.turnId) chat.opened.delete(partId);
      }
    }
  }

  /**
   * A chat's transcript was restated whole (a cloud chat restored while a
   * reply is being typed). `events` are the ones it was rebuilt from: the
   * parts they leave open are the chat's open parts.
   */
  restored(sessionId: string, events: readonly AnyLifecycleEvent[]): void {
    const chat: Chat = { seq: this.chats.get(sessionId)?.seq ?? 0, opened: new Map() };
    for (const event of events) {
      if (isUnknownEvent(event) || event.type !== "message.part" || !isOpen(event.part)) continue;
      chat.opened.set(event.part.id, { ...event, sessionId });
    }
    this.chats.set(sessionId, chat);
  }

  /**
   * A chat's open parts as `conversation` has them now (every delta applied),
   * as the live frames a subscriber is sent.
   */
  of(sessionId: string, conversation: ConversationState | undefined): SessionEvent[] {
    const chat = this.chats.get(sessionId);
    if (!chat || !conversation) return [];
    const frames: SessionEvent[] = [];
    for (const opened of chat.opened.values()) {
      const part = findConversationMessage(conversation, opened.messageId)?.parts.find(
        (candidate) => candidate.id === opened.part.id
      );
      // Closed since (a restored transcript, a turn that ended): its kept snapshot says it all.
      if (!part || !isOpen(part)) continue;
      frames.push({
        type: "event",
        envelope: { sessionId, seq: chat.seq, live: true, event: { ...opened, part } },
      });
    }
    return frames;
  }
}
