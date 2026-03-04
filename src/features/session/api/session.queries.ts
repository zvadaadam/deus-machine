/**
 * Session Query Hooks
 * TanStack Query hooks for Claude Code session management
 */

import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import { produce } from "immer";
import { SessionService } from "./session.service";
import type { PaginatedMessages } from "./session.service";
import { queryKeys } from "@/shared/api/queryKeys";
import {
  MESSAGE_PAGE_SIZE,
  INITIAL_MESSAGE_PAGE_SIZE,
  incrementalFetchAndMerge,
} from "../lib/messageCache";
import type {
  ContentBlock,
  Message,
  Session,
  SessionStatus,
  ToolResultBlock,
} from "../types";
import type { RepoGroup } from "@shared/types/workspace";
import { useMemo, useCallback } from "react";
import { track } from "@/platform/analytics";
import { parseContentBlocks } from "../lib/contentParser";
import { socketService } from "@/platform/socket";
import type { RuntimeAgentType } from "../lib/agentRuntime";

/**
 * Fetch all sessions for a workspace (used by chat tab reconstruction).
 * Stale time is high — tabs only hydrate on mount and after creating new sessions.
 */
export function useWorkspaceSessions(workspaceId: string | null) {
  return useQuery({
    queryKey: queryKeys.sessions.byWorkspace(workspaceId || ""),
    queryFn: () => SessionService.fetchByWorkspace(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 30_000,
  });
}

/**
 * Fetch session details — fully event-driven, no polling.
 *
 * Updates come from Tauri events handled by useSessionEvents:
 * - session:status-changed → setQueryData (direct cache write)
 * - session:error → setQueryData (direct cache write)
 *
 * On mount, useSessionEvents does a catch-up fetch + invalidateQueries
 * to reconcile any changes missed while unmounted (navigation, app reopen).
 */
export function useSession(sessionId: string | null) {
  return useQuery({
    queryKey: queryKeys.sessions.detail(sessionId || ""),
    queryFn: () => SessionService.fetchById(sessionId!),
    enabled: !!sessionId,
    staleTime: 10_000,
  });
}

/**
 * Subscribe to per-session working status for multiple sessions at once.
 * Used by the tab bar to show per-tab spinners correctly.
 *
 * The workspace's single `session_status` field breaks with multiple tabs —
 * it gets overwritten by whichever session's event fires last. This hook
 * subscribes to each session's detail cache reactively so tab spinners
 * reflect each session's actual status.
 *
 * No extra HTTP fetches when data is already in cache (populated by
 * useSessionEvents via setQueryData on status changes).
 */
export function useWorkingSessionIds(sessionIds: string[]): Set<string> {
  const queries = useQueries({
    queries: sessionIds.map((id) => ({
      queryKey: queryKeys.sessions.detail(id),
      queryFn: () => SessionService.fetchById(id),
      staleTime: 30_000,
      select: (data: Session): SessionStatus => data.status,
    })),
  });

  // Derive a stable string key from statuses to avoid creating a new Set
  // on every render — only re-compute when a status actually changes.
  const statusKey = queries.map((q) => q.data ?? "unknown").join(",");

  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => {
    const ids = new Set<string>();
    sessionIds.forEach((id, i) => {
      if (queries[i]?.data === "working") ids.add(id);
    });
    return ids;
  }, [statusKey, sessionIds]);
}

/**
 * Fetch messages for a session with smart fallback
 * - Desktop (Tauri): Real-time events, no polling
 * - Web (Browser): Smart polling when session is working
 *
 * Returns Message[] via `select` so downstream consumers are unchanged.
 * Raw cache holds PaginatedMessages for optimistic updates.
 */
export function useMessages(sessionId: string | null) {
  const query = useQuery({
    queryKey: queryKeys.sessions.messages(sessionId || ""),
    queryFn: () => SessionService.fetchMessages(sessionId!, { limit: INITIAL_MESSAGE_PAGE_SIZE }),
    enabled: !!sessionId,
    // No select — expose full PaginatedMessages for has_older/has_newer.
    // All updates are manual: Tauri events do incremental fetch, web mode uses polling hook.
    refetchInterval: false,
    staleTime: Infinity,
  });

  return query;
}

/**
 * Combined hook for session + messages + status
 * Replaces the complex useMessages hook
 */
export function useSessionWithMessages(sessionId: string | null) {
  const sessionQuery = useSession(sessionId);
  const messagesQuery = useMessages(sessionId);

  // Unwrap messages from PaginatedMessages (select was removed to expose has_older)
  const messages = messagesQuery.data?.messages ?? [];
  const hasOlder = messagesQuery.data?.has_older ?? false;

  // Parse content helper — delegates to pure function in lib/contentParser.ts
  // Memoized to prevent Context cascade re-renders
  const parseContent = useCallback(
    (content: string): (ContentBlock | string)[] | string => parseContentBlocks(content),
    []
  );

  // Build tool result map and parent_tool_use_id map in a single pass.
  const { toolResultMap, parentToolUseMap } = useMemo(() => {
    const resultMap = new Map();
    const parentMap = new Map<string, string>();
    if (!messages.length) return { toolResultMap: resultMap, parentToolUseMap: parentMap };

    messages.forEach((msg: Message) => {
      if (msg.parent_tool_use_id) {
        parentMap.set(msg.id, msg.parent_tool_use_id);
      }

      const blocks = parseContent(msg.content);
      if (Array.isArray(blocks)) {
        blocks.forEach((block) => {
          if (
            typeof block === "object" &&
            block &&
            "type" in block &&
            "tool_use_id" in block &&
            block.type === "tool_result"
          ) {
            resultMap.set((block as { tool_use_id: string }).tool_use_id, block as ToolResultBlock);
          }
        });
      }
    });

    return { toolResultMap: resultMap, parentToolUseMap: parentMap };
  }, [messages, parseContent]);

  // Group subagent messages by their parent Task tool_use_id
  const subagentMessages = useMemo(() => {
    const map = new Map<string, Message[]>();
    if (!messages.length) return map;

    messages.forEach((msg: Message) => {
      const parentId = parentToolUseMap.get(msg.id);
      if (parentId) {
        if (!map.has(parentId)) map.set(parentId, []);
        map.get(parentId)!.push(msg);
      }
    });

    return map;
  }, [messages, parentToolUseMap]);

  // Get latest user message's sent_at for duration tracking
  const latestMessageSentAt = useMemo(() => {
    if (!messages.length) return null;

    // Find the latest user message
    const latestUserMessage = [...messages].reverse().find((msg: Message) => msg.role === "user");

    return latestUserMessage?.sent_at || null;
  }, [messages]);

  return {
    session: sessionQuery.data,
    messages,
    hasOlder,
    sessionStatus: (sessionQuery.data?.status as SessionStatus) || "idle",
    latestMessageSentAt,
    loading: sessionQuery.isLoading || messagesQuery.isLoading,
    error: sessionQuery.error || messagesQuery.error,
    parseContent,
    toolResultMap,
    parentToolUseMap,
    subagentMessages,
  };
}

/**
 * Load older messages (scroll-up pagination).
 * Prepends older messages to the cache while preserving has_newer from current cache.
 */
export function useLoadOlderMessages() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ sessionId, beforeSeq }: { sessionId: string; beforeSeq: number }) =>
      SessionService.fetchMessages(sessionId, { before: beforeSeq, limit: MESSAGE_PAGE_SIZE }),

    onSuccess: (olderPage, { sessionId }) => {
      queryClient.setQueryData<PaginatedMessages>(queryKeys.sessions.messages(sessionId), (old) => {
        if (!old) return olderPage;
        // Deduplicate by id (shouldn't happen, but safety first)
        const existingIds = new Set(old.messages.map((m) => m.id));
        const newMessages = olderPage.messages.filter((m) => !existingIds.has(m.id));
        return {
          messages: [...newMessages, ...old.messages],
          has_older: olderPage.has_older,
          has_newer: old.has_newer,
        };
      });
    },
  });
}

/**
 * Send message mutation with optimistic update
 *
 * Shows user message immediately in the chat while request is in flight.
 * The optimistic message has a temporary ID that gets replaced on refetch.
 */
export function useSendMessage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      sessionId,
      content,
      model,
      cwd,
      agentType,
    }: {
      sessionId: string;
      content: string;
      model?: string;
      cwd?: string;
      agentType?: RuntimeAgentType;
    }): Promise<Message | void> => {
      // Desktop (Tauri): sidecar saves message + starts agent atomically.
      // The sidecar's onQuery handler persists the user message and sets
      // status='working' in a single SQLite transaction before dispatching
      // the agent — no partial-commit failure mode.
      if (cwd) {
        const ack = await socketService.sendQuery(
          sessionId,
          content,
          { cwd, model },
          agentType || "claude"
        );
        if (!ack.accepted) {
          throw new Error(ack.reason || "Agent rejected the query");
        }
        // No return value needed — onSettled ignores the mutationFn result.
        // The real message is in the DB; incremental fetch in onSettled picks it up.
        return;
      }
      // Gateway/web fallback: HTTP POST to backend
      return SessionService.sendMessage(sessionId, content, model);
    },

    // Optimistic update: show user message immediately.
    // Status indicators (tab spinner, sidebar) are event-driven — the sidecar
    // emits session:status-changed which arrives within ~50ms via Tauri events.
    // Both useSessionEvents and useGlobalSessionNotifications write directly
    // to their respective caches via setQueryData (no HTTP round-trip).
    onMutate: async ({ sessionId, content, model }) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.sessions.messages(sessionId),
      });

      const previousMessages = queryClient.getQueryData<PaginatedMessages>(
        queryKeys.sessions.messages(sessionId)
      );

      // Create optimistic user message
      const optimisticId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? `optimistic-${crypto.randomUUID()}`
          : `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Content may be plain text or a JSON-stringified content blocks array (when images attached).
      let optimisticContentJson: string;
      try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
          optimisticContentJson = JSON.stringify(parsed);
        } else {
          optimisticContentJson = JSON.stringify([{ type: "text", text: content }]);
        }
      } catch {
        optimisticContentJson = JSON.stringify([{ type: "text", text: content }]);
      }

      const optimisticMessage: Message = {
        id: optimisticId,
        session_id: sessionId,
        seq: Number.MAX_SAFE_INTEGER,
        role: "user",
        content: optimisticContentJson,
        sent_at: new Date().toISOString(),
        model: model ?? null,
      };

      queryClient.setQueryData<PaginatedMessages>(queryKeys.sessions.messages(sessionId), (old) => {
        if (!old) return { messages: [optimisticMessage], has_older: false, has_newer: false };
        return produce(old, (draft) => {
          draft.messages.push(optimisticMessage);
        });
      });

      // Optimistically set workspace status to "working" in sidebar cache.
      // Handles the startup race where the first Tauri event arrives before
      // the workspace list has loaded (cache empty → event matching fails).
      queryClient.setQueriesData<RepoGroup[]>(
        { queryKey: ["workspaces", "by-repo"] },
        (old) => {
          if (!old) return old;
          return old.map((group) => ({
            ...group,
            workspaces: group.workspaces.map((ws) =>
              ws.current_session_id === sessionId
                ? { ...ws, session_status: "working" as SessionStatus }
                : ws
            ),
          }));
        }
      );

      return { previousMessages };
    },

    onError: (_err, variables, context) => {
      // Roll back optimistic message
      if (context?.previousMessages) {
        queryClient.setQueryData(
          queryKeys.sessions.messages(variables.sessionId),
          context.previousMessages
        );
      }
      // Roll back optimistic workspace status
      queryClient.setQueriesData<RepoGroup[]>(
        { queryKey: ["workspaces", "by-repo"] },
        (old) => {
          if (!old) return old;
          return old.map((group) => ({
            ...group,
            workspaces: group.workspaces.map((ws) =>
              ws.current_session_id === variables.sessionId
                ? { ...ws, session_status: "idle" as SessionStatus }
                : ws
            ),
          }));
        }
      );
    },

    onSettled: async (_, error, variables) => {
      if (!error) {
        const hasImages = (() => {
          try {
            const parsed = JSON.parse(variables.content);
            return (
              Array.isArray(parsed) && parsed.some((b: { type?: string }) => b.type === "image")
            );
          } catch {
            return false;
          }
        })();
        const session = queryClient.getQueryData<Session>(
          queryKeys.sessions.detail(variables.sessionId)
        );
        track("session_message_sent", {
          session_id: variables.sessionId,
          has_images: hasImages,
          model: variables.model,
          agent_type: session?.agent_type,
          message_count: session?.message_count,
          context_used_percent: session?.context_used_percent,
        });
      }

      // Reconcile optimistic placeholder with real DB record.
      // Session detail is NOT invalidated here — status updates arrive via
      // session:status-changed Tauri events handled by useSessionEvents.
      await incrementalFetchAndMerge(
        queryClient,
        variables.sessionId,
        queryKeys.sessions.messages(variables.sessionId)
      );
    },
  });
}

/**
 * Stop session mutation
 */
export function useStopSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (sessionId: string) => SessionService.stop(sessionId),
    onSuccess: (_, sessionId) => {
      const session = queryClient.getQueryData<Session>(queryKeys.sessions.detail(sessionId));
      track("session_stopped", {
        session_id: sessionId,
        agent_type: session?.agent_type,
      });
      // Invalidate session to update status
      queryClient.invalidateQueries({
        queryKey: queryKeys.sessions.detail(sessionId),
      });
    },
  });
}

/**
 * Create a new session for a workspace.
 * Used when user opens a new chat tab (Cmd+T).
 * Backend creates the session and updates workspace.current_session_id.
 */
export function useCreateSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (workspaceId: string) => SessionService.createSession(workspaceId),
    onSuccess: (newSession, workspaceId) => {
      track("session_created", {
        workspace_id: workspaceId,
        agent_type: newSession?.agent_type,
        model: newSession?.model,
      });
      // Invalidate workspace lists so sidebar picks up new current_session_id
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspaces.byRepo(),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspaces.detail(workspaceId),
      });
      // Invalidate workspace sessions so chat tabs pick up the new session
      queryClient.invalidateQueries({
        queryKey: queryKeys.sessions.byWorkspace(workspaceId),
      });
    },
  });
}
