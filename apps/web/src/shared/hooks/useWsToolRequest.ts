// src/shared/hooks/useWsToolRequest.ts
//
// Shared hook that listens for tool:request events arriving via the WebSocket
// q:event channel. Dispatches to a handler callback and sends responses back
// via q:tool_response.
//
// Multiple hook instances (e.g. useAgentRpcHandler) may be mounted
// simultaneously. A module-level Set prevents duplicate responses to
// the same requestId.
//
// Usage in RPC handler hooks:
//   useWsToolRequest((method, requestId, params, respond) => {
//     match(method)
//       .with("getDiff", () => handleGetDiff(params, respond))
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

  // Track handled requestIds to prevent duplicate responses across hook instances.
  // Using a module-level Set so it's shared across all instances within the same page.
  const handledRef = useRef(handledRequestIds);

  useEffect(() => {
    const unsubscribe = onEvent((event: string, data: unknown) => {
      if (event !== "tool:request") return;

      const payload = data as ToolRequestEventData;
      if (!payload?.requestId || !payload?.method) return;

      const { requestId, method, params } = payload;

      // Check if already handled by another hook instance
      if (handledRef.current.has(requestId)) return;

      const respond = (result: unknown) => {
        if (handledRef.current.has(requestId)) return; // guard double-response
        if (!sendToolResponse(requestId, result)) return; // WS send failed — let other handlers try
        handledRef.current.add(requestId);
        scheduleCleanup(requestId);
      };

      const respondError = (error: string) => {
        if (handledRef.current.has(requestId)) return;
        if (!sendToolResponse(requestId, undefined, error)) return;
        handledRef.current.add(requestId);
        scheduleCleanup(requestId);
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
