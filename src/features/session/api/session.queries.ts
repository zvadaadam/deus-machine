/**
 * Session Query Hooks
 * TanStack Query hooks for Claude Code session management
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { produce } from "immer";
import { SessionService, type PaginatedMessages } from "./session.service";
import { queryKeys } from "@/shared/api/queryKeys";
import { MESSAGE_PAGE_SIZE, mergeNewerMessages, getLastRealSeq } from "../lib/messageCache";
import type {
  ContentBlock,
  Message,
  Session,
  SessionStatus,
  ToolResultBlock,
  ToolUseBlock,
} from "../types";
import { useMemo, useCallback } from "react";

/**
 * Fetch session details with dynamic polling based on status
 *
 * NOTE: Polling is kept even on desktop because:
 * - Only `session:message` events are implemented (not status changes)
 * - Session status updates (working → idle) still need polling
 * - Future: Implement session status events to eliminate polling on desktop
 */
export function useSession(sessionId: string | null) {
  return useQuery({
    queryKey: queryKeys.sessions.detail(sessionId || ""),
    queryFn: () => SessionService.fetchById(sessionId!),
    enabled: !!sessionId,
    // useSessionEvents invalidates on session:message events, but status
    // transitions (working → idle) can happen without a message event
    // (e.g., Claude completes, process crashes). Keep a low-frequency fallback
    // poll until session:status-changed events are implemented.
    refetchInterval: (query) => {
      const session = query.state.data as Session | undefined;
      return session?.status === "working" ? 5000 : false;
    },
    staleTime: 10000, // 10 seconds (was 500ms)
  });
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
    queryFn: () => SessionService.fetchMessages(sessionId!, { limit: MESSAGE_PAGE_SIZE }),
    enabled: !!sessionId,
    // No select — expose full PaginatedMessages for has_older/has_newer.
    // All updates are manual: Tauri events do incremental fetch, web mode uses polling hook.
    refetchInterval: false,
    staleTime: Infinity,
  });

  return query;
}

const normalizeContentBlocks = (blocks: unknown): (ContentBlock | string)[] | string | null => {
  if (Array.isArray(blocks)) {
    let didChange = false;
    const normalized = blocks.map((block) => {
      if (block == null) {
        didChange = true;
        return "";
      }

      if (typeof block !== "object") {
        if (typeof block === "string") {
          return block;
        }
        didChange = true;
        return String(block);
      }

      if (Array.isArray(block)) {
        didChange = true;
        return JSON.stringify(block);
      }

      const blockType = (block as { type?: unknown }).type;
      if (typeof blockType !== "string") {
        didChange = true;
        return JSON.stringify(block);
      }
      if (blockType !== "tool_use") {
        return block as ContentBlock;
      }

      const toolBlock = block as ToolUseBlock;
      const input =
        toolBlock.input && typeof toolBlock.input === "object" && !Array.isArray(toolBlock.input)
          ? toolBlock.input
          : {};

      if (input === toolBlock.input) {
        return toolBlock;
      }

      didChange = true;
      return { ...toolBlock, input };
    });

    return didChange ? normalized : (blocks as (ContentBlock | string)[]);
  }

  if (blocks == null) {
    return null;
  }

  if (typeof blocks === "string") {
    return blocks;
  }

  if (typeof blocks === "object") {
    if ("type" in blocks && typeof (blocks as { type?: unknown }).type === "string") {
      return normalizeContentBlocks([blocks as ContentBlock]);
    }
    return JSON.stringify(blocks);
  }

  return String(blocks);
};

/**
 * Combined hook for session + messages + status
 * Replaces the complex useMessages hook
 */
export function useSessionWithMessages(sessionId: string | null) {
  const sessionQuery = useSession(sessionId);
  const _sessionStatus = (sessionQuery.data?.status as SessionStatus) || "idle";
  const messagesQuery = useMessages(sessionId);

  // Unwrap messages from PaginatedMessages (select was removed to expose has_older)
  const messages = messagesQuery.data?.messages ?? [];
  const hasOlder = messagesQuery.data?.has_older ?? false;

  // Parse content helper (from original useMessages)
  // Memoized to prevent Context cascade re-renders
  const parseContent = useCallback((content: string): string | (ContentBlock | string)[] | null => {
    try {
      const parsed = JSON.parse(content);

      // User messages with images: content is stored as a JSON content blocks array
      // (e.g., [{"type":"text","text":"..."}, {"type":"image","source":{...}}])
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.type) {
        return normalizeContentBlocks(parsed);
      }

      // Assistant messages: wrapped in { message: { content: [...] } } envelope
      // Use nullish coalescing to preserve explicit empty strings/arrays from the backend.
      const blocks =
        (parsed as { message?: { content?: unknown }; content?: unknown }).message?.content ??
        (parsed as { content?: unknown }).content ??
        [];
      return normalizeContentBlocks(blocks);
    } catch {
      // If JSON.parse fails, treat it as plain text
      return [{ type: "text", text: content }];
    }
  }, []); // Empty deps - pure function with no external dependencies

  // Build tool result map AND parent_tool_use_id map in a single pass.
  // Both require JSON.parse of the outer envelope — merging avoids parsing twice per message.
  const { toolResultMap, parentToolUseMap } = useMemo(() => {
    const resultMap = new Map();
    const parentMap = new Map<string, string>();
    if (!messages.length) return { toolResultMap: resultMap, parentToolUseMap: parentMap };

    messages.forEach((msg: Message) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(msg.content);
      } catch {
        return;
      }

      // Extract parent_tool_use_id from outer envelope (subagent messages)
      if (typeof parsed.parent_tool_use_id === "string") {
        parentMap.set(msg.id, parsed.parent_tool_use_id);
      }

      // Extract tool_result blocks for linking tool_use → tool_result
      const blocks = normalizeContentBlocks(
        (parsed.message as Record<string, unknown> | undefined)?.content ?? parsed.content ?? []
      );
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
  }, [messages]);

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
    mutationFn: ({
      sessionId,
      content,
      model,
    }: {
      sessionId: string;
      content: string;
      model?: string;
    }) => SessionService.sendMessage(sessionId, content, model),

    // Optimistic update: Add user message to chat immediately
    // Note: Cache holds PaginatedMessages shape, not raw Message[]
    onMutate: async ({ sessionId, content, model }) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.sessions.messages(sessionId),
      });

      const previousData = queryClient.getQueryData<PaginatedMessages>(
        queryKeys.sessions.messages(sessionId)
      );

      // Create optimistic user message
      const optimisticId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? `optimistic-${crypto.randomUUID()}`
          : `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Content may be plain text or a JSON-stringified content blocks array (when images attached).
      // Detect JSON arrays to wrap correctly for parseContent downstream.
      let optimisticContentJson: string;
      try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
          // Already content blocks array — wrap in the envelope parseContent expects
          optimisticContentJson = JSON.stringify({ content: parsed });
        } else {
          optimisticContentJson = JSON.stringify({ content: [{ type: "text", text: content }] });
        }
      } catch {
        // Plain text
        optimisticContentJson = JSON.stringify({ content: [{ type: "text", text: content }] });
      }

      const optimisticMessage: Message = {
        id: optimisticId,
        session_id: sessionId,
        seq: Number.MAX_SAFE_INTEGER, // Placeholder — real seq assigned by DB trigger
        role: "user",
        content: optimisticContentJson,
        created_at: new Date().toISOString(),
        sent_at: new Date().toISOString(),
        model: model ?? null,
      };

      queryClient.setQueryData<PaginatedMessages>(queryKeys.sessions.messages(sessionId), (old) => {
        if (!old) return { messages: [optimisticMessage], has_older: false, has_newer: false };
        return produce(old, (draft) => {
          draft.messages.push(optimisticMessage);
        });
      });

      // Also update session status to "working"
      const previousSession = queryClient.getQueryData<Session>(
        queryKeys.sessions.detail(sessionId)
      );

      queryClient.setQueryData<Session>(queryKeys.sessions.detail(sessionId), (old) => {
        if (!old) return old;
        return produce(old, (draft) => {
          draft.status = "working";
        });
      });

      return { previousData, previousSession };
    },

    onError: (_err, variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(
          queryKeys.sessions.messages(variables.sessionId),
          context.previousData
        );
      }
      if (context?.previousSession) {
        queryClient.setQueryData(
          queryKeys.sessions.detail(variables.sessionId),
          context.previousSession
        );
      }
    },

    onSettled: async (_, __, variables) => {
      // Incremental fetch: only get messages newer than what we have,
      // then merge into cache (removing optimistic placeholders).
      // Falls back to full invalidation if no cache exists.
      const cached = queryClient.getQueryData<PaginatedMessages>(
        queryKeys.sessions.messages(variables.sessionId)
      );

      if (cached) {
        try {
          const lastSeq = getLastRealSeq(cached.messages);
          const newer = await SessionService.fetchMessages(variables.sessionId, {
            after: lastSeq || undefined,
            limit: MESSAGE_PAGE_SIZE,
          });
          queryClient.setQueryData<PaginatedMessages>(
            queryKeys.sessions.messages(variables.sessionId),
            (old) => mergeNewerMessages(old, newer)
          );
        } catch {
          // Incremental fetch failed — fall back to full invalidation
          queryClient.invalidateQueries({
            queryKey: queryKeys.sessions.messages(variables.sessionId),
          });
        }
      } else {
        queryClient.invalidateQueries({
          queryKey: queryKeys.sessions.messages(variables.sessionId),
        });
      }

      // Always refresh session status (working → idle transitions)
      queryClient.invalidateQueries({
        queryKey: queryKeys.sessions.detail(variables.sessionId),
      });
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
 * Backend creates the session and updates workspace.active_session_id.
 */
export function useCreateSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (workspaceId: string) => SessionService.createSession(workspaceId),
    onSuccess: (_newSession, workspaceId) => {
      // Invalidate workspace lists so sidebar picks up new active_session_id
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspaces.byRepo(),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspaces.detail(workspaceId),
      });
    },
  });
}
