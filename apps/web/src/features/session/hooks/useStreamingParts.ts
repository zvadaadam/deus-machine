/**
 * useStreamingParts — Real-time Part event accumulator
 *
 * Subscribes to q:event frames for part:created, part:delta, part:done
 * and accumulates them into PartRow[] per messageId. This provides
 * real-time streaming data that the frontend uses until the DB parts
 * arrive via the normal WS subscription.
 *
 * Lifecycle:
 *   part:created → INSERT new PartRow into the Map
 *   part:delta   → Append delta text (batched per rAF for performance)
 *   part:done    → REPLACE PartRow with finalized version
 *
 * The hook is session-scoped — it only accumulates parts for the given sessionId.
 * Streaming parts are cleared per-message when the DB parts arrive (handled
 * by the consumer comparing DB parts count to streaming parts count).
 *
 * Performance:
 *   part:delta events arrive at high frequency (~50-100/s per active text part).
 *   Deltas are accumulated in a string buffer and flushed once per rAF, so
 *   JSON re-serialization and React re-renders happen at ~60fps max, not per-token.
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { onEvent } from "@/platform/ws";
import type { PartRow } from "@/shared/types";
import type {
  PartCreatedEventData,
  PartDeltaEventData,
  PartDoneEventData,
} from "@shared/types/query-protocol";
import type { Part } from "@shared/messages/types";

// ---- Types ----

/** Map of partId → PartRow for live-streaming parts. */
type PartMap = Map<string, PartRow>;

/** Map of messageId → PartMap. Groups streaming parts by their message. */
type MessagePartsMap = Map<string, PartMap>;

interface StreamingPartsStore {
  /** Current state: messageId → (partId → PartRow) */
  state: MessagePartsMap;
  /** Monotonic sequence counter — maintains insertion order within this store. */
  seqCounter: number;
  /** Monotonic version counter — bumped on every mutation for useSyncExternalStore. */
  version: number;
  /** Registered listeners (useSyncExternalStore subscribe pattern). */
  listeners: Set<() => void>;
  /** Pending deltas batched for next rAF. partId → accumulated delta text. */
  pendingDeltas: Map<string, string>;
  /** rAF handle for delta flushing, or null if no flush is scheduled. */
  deltaFlushRaf: number | null;
}

// ---- Part → PartRow conversion ----

function partToPartRow(part: Part, seq: number): PartRow {
  return {
    id: part.id,
    message_id: part.messageId,
    session_id: part.sessionId,
    seq,
    type: part.type,
    data: JSON.stringify(part),
    tool_call_id: part.type === "TOOL" ? part.toolCallId : null,
    tool_name: part.type === "TOOL" ? part.toolName : null,
    parent_tool_call_id: part.parentToolCallId ?? null,
  };
}

// ---- Store operations ----

function createStore(): StreamingPartsStore {
  return {
    state: new Map(),
    seqCounter: 0,
    version: 0,
    listeners: new Set(),
    pendingDeltas: new Map(),
    deltaFlushRaf: null,
  };
}

function notifyListeners(store: StreamingPartsStore): void {
  store.version++;
  for (const listener of store.listeners) {
    listener();
  }
}

function handlePartCreated(store: StreamingPartsStore, data: PartCreatedEventData): void {
  const { messageId, partId, part } = data;
  const seq = ++store.seqCounter;
  const row = partToPartRow(part, seq);

  let msgParts = store.state.get(messageId);
  if (!msgParts) {
    msgParts = new Map();
    store.state.set(messageId, msgParts);
  }
  msgParts.set(partId, row);
  notifyListeners(store);
}

/**
 * Queue a delta for batched flushing. Multiple deltas arriving in the same
 * frame are concatenated and applied once in the next rAF.
 */
function handlePartDelta(store: StreamingPartsStore, data: PartDeltaEventData): void {
  const { partId, delta } = data;

  // Accumulate delta text for this partId
  const existing = store.pendingDeltas.get(partId);
  store.pendingDeltas.set(partId, existing ? existing + delta : delta);

  // Schedule a flush if one isn't already pending
  if (store.deltaFlushRaf === null) {
    store.deltaFlushRaf = requestAnimationFrame(() => {
      flushDeltas(store);
    });
  }
}

/**
 * Apply all pending deltas in a single batch, then notify listeners once.
 */
function flushDeltas(store: StreamingPartsStore): void {
  store.deltaFlushRaf = null;

  if (store.pendingDeltas.size === 0) return;

  let mutated = false;

  for (const [partId, delta] of store.pendingDeltas) {
    // Find the PartRow across all messages
    for (const msgParts of store.state.values()) {
      const row = msgParts.get(partId);
      if (!row) continue;

      try {
        const parsed = JSON.parse(row.data);
        if (parsed.text != null) {
          parsed.text += delta;
        }
        // Create a new PartRow object so React detects the change
        msgParts.set(partId, { ...row, data: JSON.stringify(parsed) });
        mutated = true;
      } catch {
        // If parse fails, skip — the part:done event will fix it
      }
      break;
    }
  }

  store.pendingDeltas.clear();

  if (mutated) {
    notifyListeners(store);
  }
}

function handlePartDone(store: StreamingPartsStore, data: PartDoneEventData): void {
  const { messageId, partId, part } = data;

  // Flush any pending deltas for this part before replacing it
  if (store.pendingDeltas.has(partId)) {
    store.pendingDeltas.delete(partId);
  }

  let msgParts = store.state.get(messageId);
  if (!msgParts) {
    msgParts = new Map();
    store.state.set(messageId, msgParts);
  }

  // Preserve the sequence number from the created event if it exists
  const existing = msgParts.get(partId);
  const seq = existing?.seq ?? ++store.seqCounter;
  const row = partToPartRow(part, seq);
  msgParts.set(partId, row);
  notifyListeners(store);
}

// ---- Hook ----

/**
 * Subscribes to Part lifecycle events and accumulates streaming parts
 * into a Map<messageId, PartRow[]>.
 *
 * Returns:
 *   getPartsForMessage(messageId) — returns PartRow[] sorted by seq, or undefined
 *   clearMessage(messageId) — clears streaming parts for a message (call when DB parts arrive)
 *   hasStreamingParts() — true if there are any streaming parts in the store
 */
export function useStreamingParts(sessionId: string | null) {
  const storeRef = useRef<StreamingPartsStore>(createStore());

  // Reset store when sessionId changes
  useEffect(() => {
    const store = storeRef.current;
    store.state.clear();
    store.seqCounter = 0;
    store.pendingDeltas.clear();
    if (store.deltaFlushRaf !== null) {
      cancelAnimationFrame(store.deltaFlushRaf);
      store.deltaFlushRaf = null;
    }
    notifyListeners(store);
  }, [sessionId]);

  // Subscribe to q:event frames
  useEffect(() => {
    if (!sessionId) return;

    const unsubscribe = onEvent((event: string, rawData: unknown) => {
      const store = storeRef.current;
      const data = rawData as Record<string, unknown>;

      // Filter by sessionId
      if (data?.sessionId !== sessionId) return;

      switch (event) {
        case "part:created":
          handlePartCreated(store, data as unknown as PartCreatedEventData);
          break;
        case "part:delta":
          handlePartDelta(store, data as unknown as PartDeltaEventData);
          break;
        case "part:done":
          handlePartDone(store, data as unknown as PartDoneEventData);
          break;
      }
    });

    return () => {
      unsubscribe();
      // Cancel any pending delta flush on unmount
      const store = storeRef.current;
      if (store.deltaFlushRaf !== null) {
        cancelAnimationFrame(store.deltaFlushRaf);
        store.deltaFlushRaf = null;
      }
    };
  }, [sessionId]);

  // useSyncExternalStore for tear-free reads
  const subscribe = useCallback((listener: () => void) => {
    const store = storeRef.current;
    store.listeners.add(listener);
    return () => {
      store.listeners.delete(listener);
    };
  }, []);

  const getSnapshot = useCallback(() => {
    return storeRef.current.version;
  }, []);

  // Re-render when store version changes
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // Public API
  const getPartsForMessage = useCallback((messageId: string): PartRow[] | undefined => {
    const msgParts = storeRef.current.state.get(messageId);
    if (!msgParts || msgParts.size === 0) return undefined;

    return Array.from(msgParts.values()).sort((a, b) => a.seq - b.seq);
  }, []);

  const clearMessage = useCallback((messageId: string): void => {
    const store = storeRef.current;
    if (store.state.has(messageId)) {
      store.state.delete(messageId);
      notifyListeners(store);
    }
  }, []);

  const hasStreamingParts = useCallback((): boolean => {
    return storeRef.current.state.size > 0;
  }, []);

  const getStreamingMessageIds = useCallback((): string[] => {
    return Array.from(storeRef.current.state.keys());
  }, []);

  return { getPartsForMessage, clearMessage, hasStreamingParts, getStreamingMessageIds };
}
