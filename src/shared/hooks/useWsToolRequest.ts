// src/shared/hooks/useWsToolRequest.ts
//
// Shared hook that listens for tool:request events arriving via the WebSocket
// q:event channel (backend relay path). Dispatches to a handler callback and
// sends responses back via q:tool_response.
//
// This runs in PARALLEL with the Tauri "sidecar:request" listener during the
// transition period. Both paths are active simultaneously — the first responder
// to a given requestId wins. A Set of handled IDs prevents duplicate responses.
//
// Usage in RPC handler hooks:
//   useWsToolRequest((method, id, params) => {
//     match(method)
//       .with("getDiff", () => handleGetDiff(id, params))
//       .otherwise(() => {}); // not mine, skip
//   });

import { useEffect, useLayoutEffect, useRef } from "react";
import { onEvent, sendToolResponse } from "@/platform/ws";
import type { ToolRequestEventData } from "@shared/types/query-protocol";

/**
 * Callback signature for WS tool request handlers.
 *
 * @param method - The RPC method name (e.g., "getDiff", "browserSnapshot")
 * @param requestId - Unique ID for this request (used for response routing)
 * @param params - Method parameters
 * @param respond - Call with result to send success response
 * @param respondError - Call with error string to send error response
 */
export type WsToolRequestHandler = (
  method: string,
  requestId: string,
  params: Record<string, unknown>,
  respond: (result: unknown) => void,
  respondError: (error: string) => void
) => void;

/**
 * Hook that listens for tool:request events via WebSocket and dispatches
 * to the provided handler. The handler decides which methods to claim.
 *
 * Responses are sent via q:tool_response back through the WS connection.
 */
export function useWsToolRequest(handler: WsToolRequestHandler): void {
  const handlerRef = useRef(handler);
  useLayoutEffect(() => {
    handlerRef.current = handler;
  });

  // Track handled requestIds to prevent duplicate responses across Tauri + WS paths.
  // Using a module-level Set so it's shared across hook instances within the same page.
  const handledRef = useRef(handledRequestIds);

  useEffect(() => {
    const unsubscribe = onEvent((event: string, data: unknown) => {
      if (event !== "tool:request") return;

      const payload = data as ToolRequestEventData;
      if (!payload?.requestId || !payload?.method) return;

      const { requestId, method, params } = payload;

      // Check if already handled (by Tauri path or another WS hook instance)
      if (handledRef.current.has(requestId)) return;

      const respond = (result: unknown) => {
        if (handledRef.current.has(requestId)) return; // guard double-response
        handledRef.current.add(requestId);
        scheduleCleanup(requestId);
        sendToolResponse(requestId, result);
      };

      const respondError = (error: string) => {
        if (handledRef.current.has(requestId)) return;
        handledRef.current.add(requestId);
        scheduleCleanup(requestId);
        sendToolResponse(requestId, undefined, error);
      };

      handlerRef.current(method, requestId, params, respond, respondError);
    });

    return unsubscribe;
  }, []);
}

// ---- Deduplication state ----

/** Module-level Set of requestIds that have been responded to.
 *  Shared across all hook instances within the same page lifecycle. */
const handledRequestIds = new Set<string>();

/** Clean up old requestIds after 60s to prevent unbounded growth. */
function scheduleCleanup(requestId: string): void {
  setTimeout(() => {
    handledRequestIds.delete(requestId);
  }, 60_000);
}

/**
 * Mark a requestId as handled (called by Tauri path to prevent WS path
 * from also responding). Exported for use by the Tauri listener in
 * useAgentRpcHandler and useBrowserRpcHandler.
 */
export function markRequestHandled(requestId: string): void {
  handledRequestIds.add(requestId);
  scheduleCleanup(requestId);
}

/**
 * Check if a requestId has already been handled.
 * Used by Tauri path to skip if WS path already responded.
 */
export function isRequestHandled(requestId: string): boolean {
  return handledRequestIds.has(requestId);
}
