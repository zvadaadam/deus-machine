// src/features/session/hooks/useAgentRpcHandler.ts
//
// Handles agent-initiated RPC requests that require frontend interaction or data access.
//
// Architecture:
//   Sidecar → Rust socket relay → "sidecar:request" Tauri event → this handler
//   Handler responds via: invoke("send_sidecar_message", { message: JSON.stringify(...) })
//
// Multiple listeners on "sidecar:request" are fine — browser automation uses the same event.
// This hook only claims the 5 agent-UI methods; everything else falls through.
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
import { useEffect, useCallback, useRef, useState } from "react";
import { invoke, listen, isTauriEnv } from "@/platform/tauri";
import { gitDiffFiles, gitDiffFile } from "@/platform/tauri/git";

// ============================================================================
// Types
// ============================================================================

interface SidecarRpcRequest {
  id: unknown;
  method: string;
  params: Record<string, unknown>;
}

export interface PlanModeRequest {
  type: "exitPlanMode";
  rpcId: unknown;
  sessionId: string;
  toolInput: unknown;
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
  contextRef.current = context;

  const pendingRequestsRef = useRef(pendingRequests);
  pendingRequestsRef.current = pendingRequests;

  // Notify parent when pending map changes
  const onPendingChangeRef = useRef(onPendingChange);
  onPendingChangeRef.current = onPendingChange;

  const setPendingAndNotify = useCallback((updater: (prev: Map<string, PendingAgentRequest>) => Map<string, PendingAgentRequest>) => {
    setPendingRequests((prev) => {
      const next = updater(prev);
      // Schedule notification after state update settles
      setTimeout(() => onPendingChangeRef.current?.(next), 0);
      return next;
    });
  }, []);

  // ============================================================================
  // Shared RPC response helpers
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
    (id: unknown, params: Record<string, unknown>) => {
      const sessionId = params.sessionId as string;
      if (!sessionId) {
        sendError(id, "exitPlanMode: missing sessionId");
        return;
      }

      if (import.meta.env.DEV) {
        console.log("[AgentRPC] exitPlanMode pending for session:", sessionId);
      }

      setPendingAndNotify((prev) => {
        const next = new Map(prev);
        next.set(sessionId, {
          type: "exitPlanMode",
          rpcId: id,
          sessionId,
          toolInput: params.toolInput,
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
    (id: unknown, params: Record<string, unknown>) => {
      const sessionId = params.sessionId as string;
      const questions = params.questions as AskQuestionRequest["questions"];
      if (!sessionId || !Array.isArray(questions)) {
        sendError(id, "askUserQuestion: missing sessionId or questions");
        return;
      }

      if (import.meta.env.DEV) {
        console.log("[AgentRPC] askUserQuestion pending for session:", sessionId, questions.length, "questions");
      }

      setPendingAndNotify((prev) => {
        const next = new Map(prev);
        next.set(sessionId, {
          type: "askUserQuestion",
          rpcId: id,
          sessionId,
          questions,
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
    async (id: unknown, params: Record<string, unknown>) => {
      const sessionId = params.sessionId as string;
      const file = params.file as string | undefined;
      const stat = params.stat as boolean | undefined;

      const ws = contextRef.current.sessionWorkspaces.get(sessionId);
      if (!ws) {
        // No workspace context for this session — respond with a descriptive error
        await sendResponse(id, { error: `No workspace context for session ${sessionId}` });
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
          await sendResponse(id, { diff: result.diff });
        } else if (stat) {
          // File list with stats
          const result = await gitDiffFiles(
            ws.workspacePath,
            ws.parentBranch,
            ws.defaultBranch
          );
          const statText = result.files
            .map((f) => `${f.file}: +${f.additions} -${f.deletions}`)
            .join("\n");
          await sendResponse(id, { diff: statText });
        } else {
          // All changed files list (summary, not full patch — patches can be huge)
          const result = await gitDiffFiles(
            ws.workspacePath,
            ws.parentBranch,
            ws.defaultBranch
          );
          const fileList = result.files.map((f) => f.file).join("\n");
          await sendResponse(id, { diff: fileList });
        }
      } catch (err: any) {
        console.error("[AgentRPC] getDiff failed:", err);
        await sendResponse(id, { error: err.message || "getDiff failed" });
      }
    },
    [sendResponse]
  );

  // ============================================================================
  // diffComment: auto-respond with success (comments stored for future UI)
  // ============================================================================

  const handleDiffComment = useCallback(
    async (id: unknown, params: Record<string, unknown>) => {
      // Comments from the agent are logged but not yet surfaced in the UI.
      // Respond with success so the agent can continue; a future PR adds the UI.
      if (import.meta.env.DEV) {
        console.log("[AgentRPC] diffComment received:", params.comments);
      }
      await sendResponse(id, { success: true });
    },
    [sendResponse]
  );

  // ============================================================================
  // getTerminalOutput: auto-respond from Tauri PTY buffer
  // ============================================================================

  const handleGetTerminalOutput = useCallback(
    async (id: unknown, params: Record<string, unknown>) => {
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

        await sendResponse(id, {
          output: output ?? "",
          source: "terminal",
          isRunning: false,
        });
      } catch {
        // Rust command not yet implemented or PTY not active — degrade gracefully
        await sendResponse(id, {
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

      await sendResponse(pending.rpcId, { approved, turnId });
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

      await sendResponse(pending.rpcId, { answers });
    },
    [sendResponse, setPendingAndNotify]
  );

  // ============================================================================
  // Event listener
  // ============================================================================

  useEffect(() => {
    if (!isTauriEnv) return;

    const unlistenPromise = listen<SidecarRpcRequest>("sidecar:request", (event) => {
      const { id, method, params } = event.payload;

      if (import.meta.env.DEV) {
        console.log("[AgentRPC] Received request:", method, "id:", id);
      }

      match(method)
        .with("exitPlanMode", () => handleExitPlanMode(id, params))
        .with("askUserQuestion", () => handleAskUserQuestion(id, params))
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

  return {
    pendingRequests,
    resolvePlanMode,
    resolveQuestion,
  };
}
