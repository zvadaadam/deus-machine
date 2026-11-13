/**
 * useAgentEvents — follow the canonical agent stream and fold it.
 *
 * The host sends every @zvada/agent-server lifecycle envelope verbatim on a
 * chat's `sessionEvents`, and the whole conversation restated after a cloud
 * recovery. This hook owns only the browser-shaped parts of consuming it —
 * which chats to follow, the animation-frame delta flush and the debounced
 * page reload. The fold itself lives in `lib/agentEventFold`, so it can be
 * tested without React, a DOM or a socket.
 *
 * It follows every chat this runtime's cache holds a message page for, not
 * only the one on screen: turn records change when a turn starts or ends, and
 * the `messages` subscription only carries new rows. Without that, starting a
 * turn and switching tabs left the footer permanently blank. A chat nobody
 * opened is not followed, so its events are never sent here.
 *
 * The stream delivers each event once and in order, and resumes after a
 * reconnect. When the host cannot say what was missed, the chat's fold is
 * dropped and its page read again.
 */

import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "@shared/api";
import type { SessionEvent } from "@shared/api/sessions";
import { getRuntimeClient } from "@/platform/ws";
import { runtimeForQueryClient } from "@/platform/ws/runtime-client";
import { queryKeys } from "@/shared/api/queryKeys";
import { isCloudDirectEnabled } from "../cloud/cloudDirectFlag";
import { isDirectSessionCached } from "../cloud/useIsDirectSession";
import { notifyCloudAutosaveFailure } from "../cloud/notifyCloudAutosaveFailure";
import {
  flushDeltas,
  hydrateConversation,
  messagesKey,
  projectOpenParts,
  pruneFolds,
  refetchMessages,
  routeEnvelope,
  type AgentStreamContext,
  type SessionFold,
} from "../lib/agentEventFold";

/** A burst of resets must not become a burst of full-page refetches. */
const REFETCH_DEBOUNCE_MS = 250;

// A cache belongs to one authenticated runtime. Folds are retained across shell
// remounts, never across a host/grant change, even when two hosts reuse the
// same session ID.
const projections = new WeakMap<QueryClient, Map<string, SessionFold>>();

/** The session a `["sessions", "messages", id]` cache key is the page of. */
function messagePageSession(queryKey: readonly unknown[]): string | null {
  const [scope, resource, sessionId] = queryKey;
  return scope === "sessions" && resource === "messages" && typeof sessionId === "string"
    ? sessionId
    : null;
}

export function subscribeToAgentEvents(queryClient: QueryClient): () => void {
  const folds = projections.get(queryClient) ?? new Map<string, SessionFold>();
  projections.set(queryClient, folds);
  const runtime = runtimeForQueryClient(queryClient) ?? getRuntimeClient();
  pruneFolds(queryClient, folds);
  let frame: number | null = null;
  const refetchTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function usesBackend(sessionId: string): boolean {
    return (
      !isCloudDirectEnabled() ||
      (!!queryClient.getQueryData(queryKeys.sessions.detail(sessionId)) &&
        !isDirectSessionCached(queryClient, sessionId))
    );
  }

  const ctx: AgentStreamContext = {
    queryClient,
    activeSessionId: null,
    folds,
    scheduleFlush: () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        for (const [sessionId, fold] of folds) {
          if (usesBackend(sessionId)) flushDeltas(queryClient, sessionId, fold);
        }
      });
    },
    requestRefetch: (target) => {
      clearTimeout(refetchTimers.get(target));
      refetchTimers.set(
        target,
        setTimeout(() => {
          refetchTimers.delete(target);
          if (usesBackend(target)) void refetchMessages(queryClient, target);
        }, REFETCH_DEBOUNCE_MS)
      );
    },
  };

  function receive(sessionId: string, update: SessionEvent): void {
    // Disabled observers also exist for direct/unknown sessions. Only the
    // confirmed backend lane may write, including deferred work above.
    if (!usesBackend(sessionId)) return;
    const page = queryClient
      .getQueryCache()
      .find({ queryKey: messagesKey(sessionId), exact: true });
    ctx.activeSessionId = page?.getObserversCount() ? sessionId : null;
    if (update.type === "snapshot") {
      clearTimeout(refetchTimers.get(sessionId));
      refetchTimers.delete(sessionId);
      hydrateConversation(ctx, update.snapshot);
      return;
    }
    routeEnvelope(ctx, update.envelope);
  }

  /** Events were missed and the host cannot say which: what was folded may be behind. */
  function startOver(sessionId: string): void {
    folds.delete(sessionId);
    ctx.requestRefetch(sessionId);
  }

  // One subscription per chat with a message page, made when the page's query
  // is (before its first read is sent, so nothing falls between the two).
  const following = new Map<string, () => void>();
  function follow(sessionId: string): void {
    if (following.has(sessionId)) return;
    following.set(
      sessionId,
      runtime.follow(api.sessionEvents, { sessionId }, (update) => receive(sessionId, update), {
        onReset: () => startOver(sessionId),
      })
    );
  }
  for (const query of queryClient.getQueryCache().findAll({ queryKey: ["sessions", "messages"] })) {
    const sessionId = messagePageSession(query.queryKey);
    if (!sessionId) continue;
    follow(sessionId);
    // A page cached before this started (the shell left and came back on the
    // same runtime) was followed by nobody in between.
    startOver(sessionId);
  }
  const unsubCache = queryClient.getQueryCache().subscribe((event) => {
    const sessionId = messagePageSession(event.query.queryKey);
    if (!sessionId) return;
    if (event.type === "added") follow(sessionId);
    // A page was read (not written here): the fold is ahead of it wherever a part is open.
    if (event.type === "updated" && event.action.type === "success" && !event.action.manual) {
      const fold = folds.get(sessionId);
      if (fold && usesBackend(sessionId)) projectOpenParts(queryClient, sessionId, fold);
    }
    if (event.type === "removed") {
      folds.delete(sessionId);
      following.get(sessionId)?.();
      following.delete(sessionId);
    }
  });

  // A turn whose work was not saved is told to every client, whatever it follows.
  const unsubSaves = runtime.follow(api.cloudSaveFailures, {}, notifyCloudAutosaveFailure);

  // Folds are kept through an outage: an open part keeps streaming onto its
  // fold when the stream resumes. Only a disposed runtime (another host,
  // account or grant) drops them.
  const unsubDispose = runtime.onDispose(() => {
    folds.clear();
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    refetchTimers.forEach((timer) => clearTimeout(timer));
    refetchTimers.clear();
  });

  return () => {
    following.forEach((stop) => stop());
    unsubSaves();
    unsubCache();
    unsubDispose();
    if (frame !== null) cancelAnimationFrame(frame);
    refetchTimers.forEach((timer) => clearTimeout(timer));
    refetchTimers.clear();
  };
}

export function useAgentEvents(): void {
  const queryClient = useQueryClient();
  useEffect(() => subscribeToAgentEvents(queryClient), [queryClient]);
}
