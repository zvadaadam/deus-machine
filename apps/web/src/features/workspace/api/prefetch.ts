/**
 * Workspace Prefetch
 *
 * Warms the TanStack Query cache on hover so workspace switches feel instant.
 * The actual reads still go through the query protocol client's one-shot
 * `sendRequest()` path; once the workspace mounts, the normal WS subscriptions
 * take over for live updates.
 *
 * Prefetches:
 * - Session messages (heaviest path when opening chat)
 * - Session detail (needed by SessionPanel)
 * - Workspace sessions (needed by chat tab hydration)
 *
 * For likely-stale workspaces (working, unread, or multi-tab restores), we
 * refresh cached data if it is older than a short hover TTL so repeated cursor
 * passes do not spam requests.
 */

import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { queryKeys } from "@/shared/api/queryKeys";
import { SessionService } from "@/features/session/api/session.service";
import type { WorkspaceState } from "@shared/enums";

const HOVER_REFRESH_WINDOW_MS = 5_000;

interface PrefetchableWorkspace {
  id: string;
  current_session_id: string | null;
  state: WorkspaceState;
}

interface PrefetchWorkspaceOptions {
  activeSessionId?: string | null;
  refreshIfCached?: boolean;
}

function shouldRefreshCachedQuery(
  queryClient: QueryClient,
  queryKey: QueryKey,
  refreshIfCached: boolean
): boolean {
  if (!refreshIfCached) return false;

  const dataUpdatedAt = queryClient.getQueryState(queryKey)?.dataUpdatedAt ?? 0;
  if (!dataUpdatedAt) return false;

  return Date.now() - dataUpdatedAt > HOVER_REFRESH_WINDOW_MS;
}

function warmQuery<TData>(
  queryClient: QueryClient,
  {
    queryKey,
    queryFn,
  }: {
    queryKey: QueryKey;
    queryFn: () => Promise<TData>;
  },
  refreshIfCached: boolean
) {
  if (shouldRefreshCachedQuery(queryClient, queryKey, refreshIfCached)) {
    void queryClient
      .fetchQuery({
        queryKey,
        queryFn,
        staleTime: 0,
      })
      .catch(() => {
        // Best-effort warmup — navigation still works with the mounted query path.
      });
    return;
  }

  void queryClient.prefetchQuery({
    queryKey,
    queryFn,
    staleTime: Infinity,
  });
}

export function prefetchWorkspace(
  queryClient: QueryClient,
  workspace: PrefetchableWorkspace,
  options: PrefetchWorkspaceOptions = {}
) {
  if (workspace.state !== "ready") return;

  const { activeSessionId = null, refreshIfCached = false } = options;
  const sessionIds = Array.from(
    new Set([activeSessionId, workspace.current_session_id].filter((id): id is string => !!id))
  );

  if (!sessionIds.length) return;

  for (const sessionId of sessionIds) {
    warmQuery(
      queryClient,
      {
        queryKey: queryKeys.sessions.messages(sessionId),
        queryFn: () => SessionService.fetchMessages(sessionId),
      },
      refreshIfCached
    );

    warmQuery(
      queryClient,
      {
        queryKey: queryKeys.sessions.detail(sessionId),
        queryFn: () => SessionService.fetchById(sessionId),
      },
      refreshIfCached
    );
  }

  warmQuery(
    queryClient,
    {
      queryKey: queryKeys.sessions.byWorkspace(workspace.id),
      queryFn: () => SessionService.fetchByWorkspace(workspace.id),
    },
    refreshIfCached
  );
}
