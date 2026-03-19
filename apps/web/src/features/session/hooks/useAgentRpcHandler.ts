// src/features/session/hooks/useAgentRpcHandler.ts
//
// Handles agent-initiated RPC requests that require frontend interaction or data access.
//
// Architecture:
//   Agent-server → Backend → q:event tool:request → this handler
//   Handler responds via: sendToolResponse (q:tool_response frame)
//
// Handled methods:
//   exitPlanMode         — user must approve/reject an agent plan (UI interaction needed)
//   askUserQuestion      — agent asks structured questions with options (UI interaction needed)
//   getDiff              — agent reads workspace diff (data fetch, auto-responds)
//   diffComment          — agent posts comments on diff (stored, auto-responds success)
//   getTerminalOutput    — agent reads terminal output (auto-responds from node-pty)
//
// Pending state is stored in a Map<sessionId, PendingRequest> so multiple concurrent
// agent sessions can each have their own pending request simultaneously.

import { match } from "ts-pattern";
import { useEffect, useLayoutEffect, useCallback, useRef, useState } from "react";
import { invoke } from "@/platform";
import { getErrorMessage } from "@shared/lib/errors";
import { gitDiffFiles, gitDiffFile } from "@/platform/electron/git";
import { useWsToolRequest } from "@/shared/hooks/useWsToolRequest";
import { sendToolResponse } from "@/platform/ws";

// ============================================================================
// Types
// ============================================================================

export interface PlanModeRequest {
  type: "exitPlanMode";
  sessionId: string;
  toolInput: unknown;
  /** WS requestId used for q:tool_response routing */
  wsRequestId: string;
}

export interface AskQuestionRequest {
  type: "askUserQuestion";
  sessionId: string;
  questions: Array<{
    question: string;
    options: string[];
    multiSelect?: boolean;
  }>;
  /** WS requestId used for q:tool_response routing */
  wsRequestId: string;
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
      workspaceId: string;
      workspacePath: string;
      parentBranch: string;
      defaultBranch: string;
    }
  >;
}

/** Response function shape used by handlers. */
type RespondFn = (result: unknown) => void;

/**
 * Hook that handles agent-initiated RPC requests from the agent-server.
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
  // exitPlanMode: store pending, wait for user approve/reject
  // ============================================================================

  const handleExitPlanMode = useCallback(
    (params: Record<string, unknown>, wsRequestId: string) => {
      const sessionId = params.sessionId as string;
      if (!sessionId) return;

      if (import.meta.env.DEV) {
        console.log("[AgentRPC] exitPlanMode pending for session:", sessionId);
      }

      setPendingAndNotify((prev) => {
        const next = new Map(prev);
        next.set(sessionId, {
          type: "exitPlanMode",
          sessionId,
          toolInput: params.toolInput,
          wsRequestId,
        } satisfies PlanModeRequest);
        return next;
      });
    },
    [setPendingAndNotify]
  );

  // ============================================================================
  // askUserQuestion: store pending, wait for user answers
  // ============================================================================

  const handleAskUserQuestion = useCallback(
    (params: Record<string, unknown>, wsRequestId: string) => {
      const sessionId = params.sessionId as string;
      const questions = params.questions as AskQuestionRequest["questions"];
      if (!sessionId || !Array.isArray(questions)) return;

      if (import.meta.env.DEV) {
        console.log(
          "[AgentRPC] askUserQuestion pending for session:",
          sessionId,
          questions.length,
          "questions"
        );
      }

      setPendingAndNotify((prev) => {
        const next = new Map(prev);
        next.set(sessionId, {
          type: "askUserQuestion",
          sessionId,
          questions,
          wsRequestId,
        } satisfies AskQuestionRequest);
        return next;
      });
    },
    [setPendingAndNotify]
  );

  // ============================================================================
  // getDiff: auto-respond using HTTP backend endpoints
  // ============================================================================

  const handleGetDiff = useCallback(async (params: Record<string, unknown>, respond: RespondFn) => {
    const sessionId = params.sessionId as string;
    const file = params.file as string | undefined;
    const stat = params.stat as boolean | undefined;

    const ws = contextRef.current.sessionWorkspaces.get(sessionId);
    if (!ws) {
      // No workspace context for this session — respond with a descriptive error
      respond({ error: `No workspace context for session ${sessionId}` });
      return;
    }

    try {
      if (file) {
        // Single-file diff
        const result = await gitDiffFile(ws.workspacePath, ws.parentBranch, ws.defaultBranch, file);
        respond({ diff: result.diff });
      } else if (stat) {
        // File list with stats
        const result = await gitDiffFiles(ws.workspacePath, ws.parentBranch, ws.defaultBranch);
        const statText = result.files
          .map((f: { file: string; additions: number; deletions: number }) => `${f.file}: +${f.additions} -${f.deletions}`)
          .join("\n");
        respond({ diff: statText });
      } else {
        // All changed files list (summary, not full patch — patches can be huge)
        const result = await gitDiffFiles(ws.workspacePath, ws.parentBranch, ws.defaultBranch);
        const fileList = result.files.map((f: { file: string }) => f.file).join("\n");
        respond({ diff: fileList });
      }
    } catch (err: unknown) {
      console.error("[AgentRPC] getDiff failed:", err);
      respond({ error: getErrorMessage(err) });
    }
  }, []);

  // ============================================================================
  // diffComment: auto-respond with success (comments stored for future UI)
  // ============================================================================

  const handleDiffComment = useCallback(
    async (params: Record<string, unknown>, respond: RespondFn) => {
      // Comments from the agent are logged but not yet surfaced in the UI.
      // Respond with success so the agent can continue; a future PR adds the UI.
      if (import.meta.env.DEV) {
        console.log("[AgentRPC] diffComment received:", params.comments);
      }
      respond({ success: true });
    },
    []
  );

  // ============================================================================
  // getTerminalOutput: auto-respond from PTY buffer
  // ============================================================================

  const handleGetTerminalOutput = useCallback(
    async (params: Record<string, unknown>, respond: RespondFn) => {
      // Terminal output reading via Electron IPC.
      // The main process exposes get_terminal_output (if implemented) or we fall back
      // to a "no terminal output available" response so the agent can continue.
      try {
        const sessionId = params.sessionId as string;
        const maxLines = (params.maxLines as number | undefined) ?? 200;

        const output = await invoke<string | null>("get_terminal_output", {
          sessionId,
          maxLines,
        });

        respond({
          output: output ?? "",
          source: "terminal",
          isRunning: false,
        });
      } catch {
        // Command not yet implemented or PTY not active — degrade gracefully
        respond({
          output: "",
          source: "none",
          isRunning: false,
          error: "Terminal output not available",
        });
      }
    },
    []
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

      sendToolResponse(pending.wsRequestId, { approved, turnId });
    },
    [setPendingAndNotify]
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

      sendToolResponse(pending.wsRequestId, { answers });
    },
    [setPendingAndNotify]
  );

  // ============================================================================
  // WS event listener (agent-server → backend → q:event tool:request)
  // ============================================================================

  useWsToolRequest((method, requestId, params, respond, _respondError) => {
    if (import.meta.env.DEV) {
      console.log("[AgentRPC] Received request (WS):", method, "requestId:", requestId);
    }

    match(method)
      .with("exitPlanMode", () => handleExitPlanMode(params, requestId))
      .with("askUserQuestion", () => handleAskUserQuestion(params, requestId))
      .with("getDiff", () => handleGetDiff(params, respond))
      .with("diffComment", () => handleDiffComment(params, respond))
      .with("getTerminalOutput", () => handleGetTerminalOutput(params, respond))
      .otherwise(() => {
        // Not an agent-UI method — browser RPC handler or other handler will claim it
      });
  });

  return {
    pendingRequests,
    resolvePlanMode,
    resolveQuestion,
  };
}
