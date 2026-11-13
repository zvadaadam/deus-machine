/**
 * File Watcher Hook
 *
 * Follows a workspace folder's changes and invalidates the caches they stale.
 *
 * 1. Component mounts with a workspace → asks the backend to watch it
 * 2. Backend chokidar detects changes → debounces → publishes on `fileChanges`
 * 3. This hook invalidates the caches (also after a reconnect, when changes
 *    may have gone unheard)
 * 4. Component unmounts → asks the backend to stop
 */

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@shared/api";
import { call, follow } from "@/platform/ws";
import { queryKeys } from "@/shared/api/queryKeys";

/** Delay before starting watcher to let filesystem settle after worktree checkout */
const WATCHER_SETTLING_DELAY_MS = 2000;

/**
 * Watch a workspace for file changes and invalidate caches on change.
 *
 * @param workspacePath - Absolute workspace path to watch (null to skip)
 * @param workspaceId   - Workspace ID for cache invalidation (null to skip)
 * @returns Whether the watcher is active (true = can disable polling)
 */
export function useFileWatcher(workspacePath: string | null, workspaceId: string | null): boolean {
  const queryClient = useQueryClient();
  const [isWatching, setIsWatching] = useState(false);

  useEffect(() => {
    let isActive = true;

    if (!workspacePath || !workspaceId) {
      // Previous effect cleanup already called setIsWatching(false).
      // No need to set state synchronously here — just bail out.
      return;
    }

    // Delay watcher start to let filesystem settle after worktree checkout.
    const settleTimeout = setTimeout(() => {
      if (!isActive) return;

      call(api.fsWatch, { workspacePath })
        .then(() => {
          if (isActive) {
            setIsWatching(true);
            // The recipe may have changed while this workspace wasn't being watched.
            queryClient.invalidateQueries({
              queryKey: queryKeys.workspaces.environment(workspaceId),
            });
          }
        })
        .catch((err: unknown) => {
          console.warn("[FileWatcher] Failed to start watching:", err);
          if (isActive) setIsWatching(false);
        });
    }, WATCHER_SETTLING_DELAY_MS);

    const readAgain = () => {
      queryClient.invalidateQueries({ queryKey: ["files", workspaceId] });
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.environment(workspaceId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.diffStats(workspaceId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.diffFiles(workspaceId) });
      // Invalidate individual file diffs — prefix match covers all files in the workspace.
      // Without this, the diff viewer shows stale content after agent edits.
      queryClient.invalidateQueries({ queryKey: ["workspaces", "diff-file", workspaceId] });
    };
    const unlisten = follow(
      api.fileChanges,
      { workspacePath },
      (change) => {
        if (change.change_type !== "metadataonly") readAgain();
      },
      { onReset: readAgain }
    );

    return () => {
      isActive = false;
      clearTimeout(settleTimeout);
      setIsWatching(false);
      call(api.fsUnwatch, { workspacePath }).catch(() => {});
      unlisten();
    };
  }, [workspacePath, workspaceId, queryClient]);

  return isWatching;
}
