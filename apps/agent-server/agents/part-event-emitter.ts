// agent-server/agents/part-event-emitter.ts
// Shared PartEvent emission helper for provider stream adapters.

import type { Part } from "@shared/messages";
import { EventBroadcaster } from "../event-broadcaster";
import type { PartEvent } from "../messages/adapter";
import type { AgentHarness } from "../protocol";

export interface PartEventEmitter {
  emit(event: PartEvent): void;
  emitMany(events: PartEvent[]): void;
}

export function createPartEventEmitter(options: {
  sessionId: string;
  agentHarness: AgentHarness;
  fallbackMessageId: string;
  getParts?: () => Part[];
}): PartEventEmitter {
  let currentMessageId = options.fallbackMessageId;

  function emit(event: PartEvent): void {
    currentMessageId = messageIdForPartEvent(event, options.getParts?.()) ?? currentMessageId;
    EventBroadcaster.emitPartEvent(
      options.sessionId,
      options.agentHarness,
      currentMessageId,
      event
    );
  }

  function emitMany(events: PartEvent[]): void {
    for (const event of events) {
      emit(event);
    }
  }

  return { emit, emitMany };
}

function messageIdForPartEvent(event: PartEvent, parts: Part[] = []): string | undefined {
  switch (event.type) {
    case "message.created":
    case "message.done":
      return event.messageId;
    case "part.created":
    case "part.done":
      return event.part.messageId;
    case "part.delta":
      return parts.find((part) => part.id === event.partId)?.messageId;
    default:
      return undefined;
  }
}
