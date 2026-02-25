// gateway/adapters/types.ts
// Unified interface for messaging platform adapters.

import type { Channel, InboundMessage, OutboundMessage } from "../types";

/**
 * ChannelAdapter — abstract interface for a messaging platform.
 * New channels (WhatsApp, Discord, etc.) implement this interface
 * and register in index.ts. Nothing else needs to change.
 */
export interface ChannelAdapter {
  readonly channel: Channel;

  /** Start receiving messages. Calls onMessage for each inbound message. */
  start(onMessage: (msg: InboundMessage) => void): Promise<void>;

  /** Send a message to a specific chat. */
  send(msg: OutboundMessage): Promise<void>;

  /** Gracefully shut down the adapter. */
  stop(): Promise<void>;
}
