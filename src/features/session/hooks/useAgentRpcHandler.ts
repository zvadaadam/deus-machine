// src/features/session/hooks/useAgentRpcHandler.ts
//
// Handles agent-initiated RPC requests that require frontend interaction or data access.
//
// Architecture (dual path during transition):
//   Path 1 (Tauri): Sidecar → Rust socket relay → "sidecar:request" Tauri event → this handler
//                    Handler responds via: invoke("send_sidecar_message", ...)
//   Path 2 (WS):    Agent-server → Backend → q:event tool:request → this handler
//                    Handler responds via: sendToolResponse (q:tool_response frame)
//
// Both paths are active simultaneously. A shared deduplication Set prevents
// double-responding to the same requestId.
//
// Handled methods:
//   exitPlanMode         — user must approve/reject an agent plan (UI interaction needed)
//   askUserQuestion      — agent asks structured questions with options (UI interaction needed)
//   getDiff              — agent reads workspace diff (data fetch, auto-responds)
//   diffComment          — agent posts comments on diff (stored, auto-responds success)
//   getTerminalOutput    — agent reads terminal output (auto-responds from Tauri PTY)
//
// Pending state is stored in a Map<sessionId, PendingRequest> so multiple concurrent
// agent sessions can each have their own pending request simultaneously.

import { match } from "ts-pattern";
import { useEffect, useLayoutEffect, useCallback, useRef, useState } from "react";
import { invoke, listen, isTauriEnv, SIDECAR_REQUEST } from "@/platform/tauri";
import { getErrorMessage } from "@shared/lib/errors";
import { gitDiffFiles, gitDiffFile } from "@/platform/tauri/git";
import {
  useWsToolRequest,
  markRequestHandled,
  isRequestHandled,
} from "@/shared/hooks/useWsToolRequest";

// ============================================================================
// Types
// ============================================================================

export interface PlanModeRequest {
  type: "exitPlanMode";
  rpcId: unknown;
  sessionId: string;
  toolInput: unknown;
  /** How to respond: "tauri" sends via Rust socket, "ws" sends via q:tool_response */
  channel: "tauri" | "ws";
  /** For WS channel: the requestId used for q:tool_response routing */
  wsRequestId?: string;
}

export interface AskQuestionRequest {
  type: "askUserQuestion";
  rpcId: unknown;
  sessionId: string;
  questions: Array<{
    question: string;
    options: string[];
    multiSelect?: boolean;
  }>;
  /** How to respond: "tauri" sends via Rust socket, "ws" sends via q:tool_response */
  channel: "tauri" | "ws";
  /** For WS channel: the requestId used for q:tool_response routing */
  wsRequestId?: string;
}

export type PendingAgentRequest = PlanModeRequest | AskQuestionRequest;

// ============================================================================
// Hook
// ============================================================================

/**
 * Context needed to auto-respond to data-fetch requests (getDiff, getTerminalOutput).
 * The workspace providing this must match the session's working directory.
 */
export interface AgentRpcContext {
  /** Map of sessionId → workspace context for that session */
  sessionWorkspaces: Map<
    string,
    {
      workspacePath: string;
      parentBranch: string;
      defaultBranch: string;
    }
  >;
}

/**
 * Hook that handles agent-initiated RPC requests from the sidecar.
 *
 * Returns a Map of pending requests that require user interaction.
 * The rendering layer (Chat or SessionPanel) renders appropriate UI for each.
 *
 * @param context - Workspace info for auto-responding to data-fetch requests
 * @param onPendingChange - Called whenever the pending request map changes
 */
export function useAgentRpcHandler(
  context: AgentRpcContext,
  onPendingChange?: (pending: Map<string, PendingAgentRequest>) => void
) {
  // Map of sessionId → pending request awaiting user interaction
  const [pendingRequests, setPendingRequests] = useState<Map<string, PendingAgentRequest>>(
    () => new Map()
  );

  // Keep refs stable across renders so handlers don't need to be recreated
  const contextRef = useRef(context);
  const pendingRequestsRef = useRef(pendingRequests);

  // Notify parent when pending map changes
  const onPendingChangeRef = useRef(onPendingChange);
  const hasCommittedPendingRequestsRef = useRef(false);

  useLayoutEffect(() => {
    contextRef.current = context;
  }, [context]);

  useLayoutEffect(() => {
    pendingRequestsRef.current = pendingRequests;
  }, [pendingRequests]);

  useLayoutEffect(() => {
    onPendingChangeRef.current = onPendingChange;
  }, [onPendingChange]);

  useEffect(() => {
    if (!hasCommittedPendingRequestsRef.current) {
      hasCommittedPendingRequestsRef.current = true;
      return;
    }

    onPendingChangeRef.current?.(pendingRequests);
  }, [pendingRequests]);

  const setPendingAndNotify = useCallback(
    (updater: (prev: Map<string, PendingAgentRequest>) => Map<string, PendingAgentRequest>) => {
      setPendingRequests((prev) => updater(prev));
    },
    []
  );

  // ============================================================================
  // Shared RPC response helpers (Tauri path)
  // ============================================================================

  const sendResponse = useCallback(async (id: unknown, result: unknown) => {
    const message = JSON.stringify({ jsonrpc: "2.0", result, id });
    try {
      await invoke("send_sidecar_message", { message });
    } catch (err) {
      console.error("[AgentRPC] Failed to send response:", err);
    }
  }, []);

  const sendError = useCallback(async (id: unknown, errorMessage: string) => {
    const message = JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: errorMessage },
      id,
    });
    try {
      await invoke("send_sidecar_message", { message });
    } catch (err) {
      console.error("[AgentRPC] Failed to send error response:", err);
    }
  }, []);

  // ============================================================================
  // exitPlanMode: store pending, wait for user approve/reject
  // ============================================================================

  const handleExitPlanMode = useCallback(
    (
      id: unknown,
      params: Record<string, unknown>,
      channel: "tauri" | "ws" = "tauri",
      wsRequestId?: string
    ) => {
      const sessionId = params.sessionId as string;
      if (!sessionId) {
        if (channel === "tauri") sendError(id, "exitPlanMode: missing sessionId");
        return;
      }

      if (import.meta.env.DEV) {
        console.log("[AgentRPC] exitPlanMode pending for session:", sessionId, `(${channel})`);
      }

      setPendingAndNotify((prev) => {
        const next = new Map(prev);
        next.set(sessionId, {
          type: "exitPlanMode",
          rpcId: id,
          sessionId,
          toolInput: params.toolInput,
          channel,
          wsRequestId,
        } satisfies PlanModeRequest);
        return next;
      });
    },
    [sendError, setPendingAndNotify]
  );

  // ============================================================================
  // askUserQuestion: store pending, wait for user answers
  // ============================================================================

  const handleAskUserQuestion = useCallback(
    (
      id: unknown,
      params: Record<string, unknown>,
      channel: "tauri" | "ws" = "tauri",
      wsRequestId?: string
    ) => {
      const sessionId = params.sessionId as string;
      const questions = params.questions as AskQuestionRequest["questions"];
      if (!sessionId || !Array.isArray(questions)) {
        if (channel === "tauri") sendError(id, "askUserQuestion: missing sessionId or questions");
        return;
      }

      if (import.meta.env.DEV) {
        console.log(
          "[AgentRPC] askUserQuestion pending for session:",
          sessionId,
          questions.length,
          `questions (${channel})`
        );
      }

      setPendingAndNotify((prev) => {
        const next = new Map(prev);
        next.set(sessionId, {
          type: "askUserQuestion",
          rpcId: id,
          sessionId,
          questions,
          channel,
          wsRequestId,
        } satisfies AskQuestionRequest);
        return next;
      });
    },
    [sendError, setPendingAndNotify]
  );

  // ============================================================================
  // getDiff: auto-respond using Tauri git IPC
  // ============================================================================

  const handleGetDiff = useCallback(
    async (
      id: unknown,
      params: Record<string, unknown>,
      respond: (id: unknown, result: unknown) => Promise<void> = sendResponse
    ) => {
      const sessionId = params.sessionId as string;
      const file = params.file as string | undefined;
      const stat = params.stat as boolean | undefined;

      const ws = contextRef.current.sessionWorkspaces.get(sessionId);
      if (!ws) {
        // No workspace context for this session — respond with a descriptive error
        await respond(id, { error: `No workspace context for session ${sessionId}` });
        return;
      }

      try {
        if (file) {
          // Single-file diff
          const result = await gitDiffFile(
            ws.workspacePath,
            ws.parentBranch,
            ws.defaultBranch,
            file
          );
          await respond(id, { diff: result.diff });
        } else if (stat) {
          // File list with stats
          const result = await gitDiffFiles(ws.workspacePath, ws.parentBranch, ws.defaultBranch);
          const statText = result.files
            .map((f) => `${f.file}: +${f.additions} -${f.deletions}`)
            .join("\n");
          await respond(id, { diff: statText });
        } else {
          // All changed files list (summary, not full patch — patches can be huge)
          const result = await gitDiffFiles(ws.workspacePath, ws.parentBranch, ws.defaultBranch);
          const fileList = result.files.map((f) => f.file).join("\n");
          await respond(id, { diff: fileList });
        }
      } catch (err: unknown) {
        console.error("[AgentRPC] getDiff failed:", err);
        await respond(id, { error: getErrorMessage(err) });
      }
    },
    [sendResponse]
  );

  // ============================================================================
  // diffComment: auto-respond with success (comments stored for future UI)
  // ============================================================================

  const handleDiffComment = useCallback(
    async (
      id: unknown,
      params: Record<string, unknown>,
      respond: (id: unknown, result: unknown) => Promise<void> = sendResponse
    ) => {
      // Comments from the agent are logged but not yet surfaced in the UI.
      // Respond with success so the agent can continue; a future PR adds the UI.
      if (import.meta.env.DEV) {
        console.log("[AgentRPC] diffComment received:", params.comments);
      }
      await respond(id, { success: true });
    },
    [sendResponse]
  );

  // ============================================================================
  // getTerminalOutput: auto-respond from Tauri PTY buffer
  // ============================================================================

  const handleGetTerminalOutput = useCallback(
    async (
      id: unknown,
      params: Record<string, unknown>,
      respond: (id: unknown, result: unknown) => Promise<void> = sendResponse
    ) => {
      // Terminal output reading via Tauri IPC.
      // The Rust side exposes get_terminal_output (if implemented) or we fall back
      // to a "no terminal output available" response so the agent can continue.
      try {
        const sessionId = params.sessionId as string;
        const maxLines = (params.maxLines as number | undefined) ?? 200;

        const output = await invoke<string | null>("get_terminal_output", {
          sessionId,
          maxLines,
        });

        await respond(id, {
          output: output ?? "",
          source: "terminal",
          isRunning: false,
        });
      } catch {
        // Rust command not yet implemented or PTY not active — degrade gracefully
        await respond(id, {
          output: "",
          source: "none",
          isRunning: false,
          error: "Terminal output not available",
        });
      }
    },
    [sendResponse]
  );

  // ============================================================================
  // Public API: resolve pending requests
  // ============================================================================

  /**
   * Called by the plan approval UI when the user clicks Approve or Reject.
   */
  const resolvePlanMode = useCallback(
    async (sessionId: string, approved: boolean, turnId?: string) => {
      const pending = pendingRequestsRef.current.get(sessionId);
      if (!pending || pending.type !== "exitPlanMode") return;

      setPendingAndNotify((prev) => {
        const next = new Map(prev);
        next.delete(sessionId);
        return next;
      });

      const result = { approved, turnId };

      if (pending.channel === "ws" && pending.wsRequestId) {
        // Respond via WS q:tool_response
        const { sendToolResponse } = await import("@/platform/ws");
        sendToolResponse(pending.wsRequestId, result);
      } else {
        // Respond via Tauri socket relay
        await sendResponse(pending.rpcId, result);
      }
    },
    [sendResponse, setPendingAndNotify]
  );

  /**
   * Called by the question UI when the user submits answers.
   * answers[i] is a string (single-select) or string[] (multi-select)
   */
  const resolveQuestion = useCallback(
    async (sessionId: string, answers: (string | string[])[]) => {
      const pending = pendingRequestsRef.current.get(sessionId);
      if (!pending || pending.type !== "askUserQuestion") return;

      setPendingAndNotify((prev) => {
        const next = new Map(prev);
        next.delete(sessionId);
        return next;
      });

      const result = { answers };

      if (pending.channel === "ws" && pending.wsRequestId) {
        // Respond via WS q:tool_response
        const { sendToolResponse } = await import("@/platform/ws");
        sendToolResponse(pending.wsRequestId, result);
      } else {
        // Respond via Tauri socket relay
        await sendResponse(pending.rpcId, result);
      }
    },
    [sendResponse, setPendingAndNotify]
  );

  // ============================================================================
  // Tauri event listener (Path 1: sidecar → Rust → Tauri event)
  // ============================================================================

  useEffect(() => {
    if (!isTauriEnv) return;

    const unlistenPromise = listen(SIDECAR_REQUEST, (event) => {
      const { id, method, params } = event.payload;

      // Skip if WS path already handled this request
      if (typeof id === "string" && isRequestHandled(id)) return;

      if (import.meta.env.DEV) {
        console.log("[AgentRPC] Received request (Tauri):", method, "id:", id);
      }

      // Mark as handled to prevent WS path from also responding
      if (typeof id === "string") markRequestHandled(id);

      match(method)
        .with("exitPlanMode", () => handleExitPlanMode(id, params, "tauri"))
        .with("askUserQuestion", () => handleAskUserQuestion(id, params, "tauri"))
        .with("getDiff", () => handleGetDiff(id, params))
        .with("diffComment", () => handleDiffComment(id, params))
        .with("getTerminalOutput", () => handleGetTerminalOutput(id, params))
        .otherwise(() => {
          // Not an agent-UI method — browser RPC handler or other handler will claim it
        });
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [
    handleExitPlanMode,
    handleAskUserQuestion,
    handleGetDiff,
    handleDiffComment,
    handleGetTerminalOutput,
  ]);

  // ============================================================================
  // WS event listener (Path 2: agent-server → backend → q:event tool:request)
  // ============================================================================

  useWsToolRequest((method, requestId, params, respond, _respondError) => {
    if (import.meta.env.DEV) {
      console.log("[AgentRPC] Received request (WS):", method, "requestId:", requestId);
    }

    // Wrap respond into the (id, result) => Promise<void> shape that handlers expect
    const wsRespond = async (_id: unknown, result: unknown) => {
      respond(result);
    };

    match(method)
      .with("exitPlanMode", () => handleExitPlanMode(requestId, params, "ws", requestId))
      .with("askUserQuestion", () => handleAskUserQuestion(requestId, params, "ws", requestId))
      .with("getDiff", () => handleGetDiff(requestId, params, wsRespond))
      .with("diffComment", () => handleDiffComment(requestId, params, wsRespond))
      .with("getTerminalOutput", () => handleGetTerminalOutput(requestId, params, wsRespond))
      .otherwise(() => {
        // Not an agent-UI method — browser RPC handler will claim it
      });
  });

  return {
    pendingRequests,
    resolvePlanMode,
    resolveQuestion,
  };
}
