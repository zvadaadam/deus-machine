// agent-server/messages/adapter.ts
// Adapter interface for transforming provider-specific SDK events into unified Parts.

import type { FinishReason, Part, TokenUsage } from "@shared/messages";

export interface StreamContext {
  sessionId: string;
  messageId: string;
}

export interface EventTransformer<TEvent> {
  process(event: TEvent): Part[];
  finish(): { parts: Part[]; usage: TokenUsage; cost?: number; finishReason?: FinishReason };
  getParts(): Part[];
}

export interface Adapter<TEvent> {
  id: string;
  createTransformer(ctx: StreamContext): EventTransformer<TEvent>;
}
