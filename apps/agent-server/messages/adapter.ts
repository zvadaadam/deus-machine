// agent-server/messages/adapter.ts
// Adapter interface for transforming provider-specific SDK events into unified Parts.

import type { Part, TokenUsage } from "@shared/messages";
import type { PartEvent } from "@shared/agent-events";

export type { PartEvent };

export interface StreamContext {
  sessionId: string;
  messageId: string;
  turnId?: string;
}

// ---------------------------------------------------------------------------
// Transformer & Adapter interfaces
// ---------------------------------------------------------------------------

export interface EventTransformer<TEvent> {
  process(event: TEvent): PartEvent[];
  finish(): { events: PartEvent[]; parts: Part[]; usage: TokenUsage; cost?: number };
  getParts(): Part[];
}

export interface Adapter<TEvent> {
  id: string;
  createTransformer(ctx: StreamContext): EventTransformer<TEvent>;
}
