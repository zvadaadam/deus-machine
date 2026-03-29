/**
 * File Watcher Hook
 *
 * Listens for filesystem change events from the backend via WebSocket and
 * invalidates relevant React Query caches.
 *
 * EVENT FLOW:
 * 1. Component mounts with a workspace → starts watching via WS command
 * 2. Backend chokidar detects changes → debounces → pushes q:event "fs:changed"
 * 3. This hook receives event → invalidates React Query caches
 * 4. Component unmounts → stops watching via WS command
 */

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { sendCommand, onEvent } from "@/platform/ws/query-protocol-client";
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

      sendCommand("fs:watch", { workspacePath })
        .then(() => {
          if (isActive) setIsWatching(true);
        })
        .catch((err: unknown) => {
          console.warn("[FileWatcher] Failed to start watching:", err);
          if (isActive) setIsWatching(false);
        });
    }, WATCHER_SETTLING_DELAY_MS);

    // Listen for debounced change events via WS
    const unlisten = onEvent((event, data) => {
      if (event !== "fs:changed") return;
      const payload = data as {
        workspace_path: string;
        change_type: string;
        affected_count: number;
      };

      // Only process events for THIS workspace
      if (payload.workspace_path !== workspacePath) return;
      if (payload.change_type === "metadataonly") return;

      if (import.meta.env.DEV) {
        console.log(`[FileWatcher] ${payload.affected_count} files changed in workspace`);
      }

      queryClient.invalidateQueries({ queryKey: ["files", workspaceId] });
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.diffStats(workspaceId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.diffFiles(workspaceId) });
      // Invalidate individual file diffs — prefix match covers all files in the workspace.
      // Without this, the diff viewer shows stale content after agent edits.
      queryClient.invalidateQueries({ queryKey: ["workspaces", "diff-file", workspaceId] });
    });

    return () => {
      isActive = false;
      clearTimeout(settleTimeout);
      setIsWatching(false);
      sendCommand("fs:unwatch", { workspacePath }).catch(() => {});
      unlisten();
    };
  }, [workspacePath, workspaceId, queryClient]);

  return isWatching;
}
