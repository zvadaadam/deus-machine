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
import { getErrorMessage } from "@shared/lib/errors";
import { sendRequest } from "@/platform/ws";
import { useWsToolRequest } from "@/shared/hooks/useWsToolRequest";
import { onEvent, sendToolResponse, TOOL_CANCEL_EVENT } from "@/platform/ws";

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

/** Fold the tool-call shapes agents actually produce into our question list. */
function normalizeQuestions(params: Record<string, unknown>): AskQuestionRequest["questions"] {
  const toEntry = (value: unknown): AskQuestionRequest["questions"][number] | null => {
    if (typeof value === "string" && value.trim()) {
      return { question: value.trim(), options: [] };
    }
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      // `text`/`allowsMultiSelect` is the cloud sidecar's own AskUserQuestion
      // shape (agnt's McpQuestionItem), which the Mac driver relays verbatim —
      // without these spellings every cloud question normalized to nothing and
      // was cancelled on arrival, and the agent reported "no answer selected".
      const question =
        typeof obj.question === "string"
          ? obj.question
          : typeof obj.prompt === "string"
            ? obj.prompt
            : typeof obj.text === "string"
              ? obj.text
              : null;
      if (!question || !question.trim()) return null;
      // Options arrive as strings (the MCP tool) or as `{label, description}`
      // objects (Claude Code's built-in AskUserQuestion, relayed through the
      // permission bridge) — the chip shows the label either way.
      const options = Array.isArray(obj.options)
        ? obj.options
            .map((o) =>
              typeof o === "string"
                ? o
                : o && typeof o === "object" && typeof (o as { label?: unknown }).label === "string"
                  ? (o as { label: string }).label
                  : ""
            )
            .filter((o) => o.trim().length > 0)
        : [];
      const multiSelect =
        typeof obj.multiSelect === "boolean"
          ? obj.multiSelect
          : typeof obj.allowsMultiSelect === "boolean"
            ? obj.allowsMultiSelect
            : undefined;
      return {
        question: question.trim(),
        options,
        ...(multiSelect !== undefined ? { multiSelect } : {}),
      };
    }
    return null;
  };

  const raw = params.questions ?? params.question;
  const list = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];
  return list.map(toEntry).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
}

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

  // The direct lane retracts a question it can no longer answer (its turn
  // ended while the socket was down): drop that request's overlay, or a stale
  // card stays answerable for an agent that has moved on.
  useEffect(
    () =>
      onEvent((event, data) => {
        if (event !== TOOL_CANCEL_EVENT) return;
        const { sessionId, requestId } = (data ?? {}) as {
          sessionId?: unknown;
          requestId?: unknown;
        };
        if (typeof sessionId !== "string" || typeof requestId !== "string") return;
        setPendingAndNotify((prev) => {
          const current = prev.get(sessionId);
          if (!current || current.wsRequestId !== requestId) return prev;
          const next = new Map(prev);
          next.delete(sessionId);
          return next;
        });
      }),
    [setPendingAndNotify]
  );

  // ============================================================================
  // exitPlanMode: store pending, wait for user approve/reject
  // ============================================================================

  const handleExitPlanMode = useCallback(
    (params: Record<string, unknown>, wsRequestId: string, respond: RespondFn) => {
      const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
      // Malformed request: complete it as a rejected plan (the schema-valid
      // cancellation) instead of leaving the agent to time out on silence.
      if (!sessionId) {
        respond({ approved: false });
        return;
      }

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
    (params: Record<string, unknown>, wsRequestId: string, respond: RespondFn) => {
      const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
      // Tolerant-reader: agents call this tool in more shapes than our schema
      // (singular question, single object, missing options). A shape we still
      // can't use must UNBLOCK the agent immediately — silently dropping the
      // request left it hanging on an invisible card until its own timeout.
      const normalized = normalizeQuestions(params);
      if (!sessionId || normalized.length === 0) {
        // Invalid sessionId or nothing usable — unblock the agent with a
        // schema-valid cancellation and store no pending request.
        // Unblock the agent with a SCHEMA-VALID cancellation — {error} violates
        // AskUserQuestionResponseSchema (needs `answers`), and the cloud path
        // would coerce it to the bogus answer "[object Object]".
        respond({ answers: ["USER_CANCELLED"] });
        return;
      }
      const questions = normalized;

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
        // Single-file diff via q:request
        const result = await sendRequest<{
          diff: string;
          old_content?: string | null;
          new_content?: string | null;
        }>("diffFile", { workspaceId: ws.workspaceId, file });
        respond({ diff: result.diff });
      } else if (stat) {
        // File list with stats via q:request
        const result = await sendRequest<{
          files: Array<{ file: string; additions: number; deletions: number }>;
        }>("diffFiles", { workspaceId: ws.workspaceId });
        const statText = result.files
          .map((f) => `${f.file}: +${f.additions} -${f.deletions}`)
          .join("\n");
        respond({ diff: statText });
      } else {
        // All changed files list (summary, not full patch — patches can be huge)
        const result = await sendRequest<{
          files: Array<{ file: string }>;
        }>("diffFiles", { workspaceId: ws.workspaceId });
        const fileList = result.files.map((f) => f.file).join("\n");
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
    async (_params: Record<string, unknown>, respond: RespondFn) => {
      // Terminal output is not available via buffered read. node-pty streams data
      // as it arrives (via q:event "pty-data" frames) and does not maintain a
      // scrollback buffer. There is no backend endpoint or Electron IPC handler
      // that can retrieve past output.
      //
      // Respond with an empty result so the agent can continue without blocking.
      respond({
        output: "",
        source: "none",
        isRunning: false,
        error: "Terminal output not available — PTY streams data in real-time without buffering",
      });
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
      .with("exitPlanMode", () => handleExitPlanMode(params, requestId, respond))
      .with("askUserQuestion", () => handleAskUserQuestion(params, requestId, respond))
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
