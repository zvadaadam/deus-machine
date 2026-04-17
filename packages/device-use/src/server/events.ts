// Event bus for tool-event + tool-log. Multiple subscribers (WS clients)
// attach; server emits whenever a tool handler runs. Reuses the MCP
// tool-call schema so there's one shape for MCP + WS, no parallel types.

import { randomUUID } from "node:crypto";

export type ToolEventStatus = "started" | "completed" | "failed";

export interface ToolEvent {
  type: "tool-event";
  id: string;
  at: number;
  tool: string;
  params: unknown;
  status: ToolEventStatus;
  result?: unknown;
  error?: string;
}

export interface ToolLog {
  type: "tool-log";
  id: string;
  stream: "stdout" | "stderr";
  text: string;
}

export type BusEvent = ToolEvent | ToolLog;

export type Subscriber = (event: BusEvent) => void;

export class EventBus {
  private readonly subscribers = new Set<Subscriber>();
  private readonly history: BusEvent[] = [];
  private readonly maxHistory: number;

  constructor(maxHistory = 200) {
    this.maxHistory = maxHistory;
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  emit(event: BusEvent): void {
    this.history.push(event);
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }
    for (const sub of this.subscribers) {
      try {
        sub(event);
      } catch (err) {
        console.warn("[events] subscriber threw:", (err as Error).message);
      }
    }
  }

  /** Recent events — used by the viewer to hydrate on load. */
  snapshot(): BusEvent[] {
    return [...this.history];
  }

  newId(): string {
    return randomUUID();
  }
}
