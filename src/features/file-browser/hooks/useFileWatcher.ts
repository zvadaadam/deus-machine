/**
 * File Watcher Hook
 *
 * Listens for filesystem change events from Rust's `notify` crate and
 * invalidates relevant React Query caches. Replaces polling for file-related
 * data on the selected workspace.
 *
 * EVENT FLOW:
 * 1. Component mounts with a workspace → starts watching via Tauri IPC
 * 2. Rust notify crate detects changes → debounces (500ms soft / 2s hard cap)
 *    → filters through .gitignore → emits "fs:changed" Tauri event
 * 3. This hook receives event → invalidates Rust file cache + React Query caches
 * 4. React Query refetches only the invalidated queries
 * 5. Component unmounts → stops watching via Tauri IPC
 */

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { listen, invoke, isTauriEnv } from "@/platform/tauri";
import { queryKeys } from "@/shared/api/queryKeys";

interface FileChangeEvent {
  workspace_path: string;
  change_type: "fileschanged" | "metadataonly";
  affected_count: number;
}

/**
 * Watch a workspace for file changes and invalidate caches on change.
 *
 * Only active in Tauri desktop environment. Returns whether watching is active,
 * which callers can use to disable polling.
 *
 * @param workspacePath - Absolute workspace path to watch (null to skip)
 * @param workspaceId   - Workspace ID for cache invalidation (null to skip)
 * @returns Whether the watcher is active (true = can disable polling)
 */
export function useFileWatcher(
  workspacePath: string | null,
  workspaceId: string | null,
): boolean {
  const queryClient = useQueryClient();
  const [isWatching, setIsWatching] = useState(false);

  useEffect(() => {
    let isActive = true;

    if (!isTauriEnv || !workspacePath || !workspaceId) {
      setIsWatching(false);
      return;
    }

    // Start watching
    invoke("watch_workspace", { workspacePath })
      .then(() => {
        if (isActive) setIsWatching(true);
      })
      .catch((err: unknown) => {
        console.warn("[FileWatcher] Failed to start watching:", err);
        if (isActive) setIsWatching(false);
      });

    // Listen for debounced change events
    const unlistenPromise = listen<FileChangeEvent>(
      "fs:changed",
      (event) => {
        const { workspace_path, change_type, affected_count } = event.payload;

        // Only process events for THIS workspace
        if (workspace_path !== workspacePath) return;

        // Skip metadata-only changes (permissions, timestamps)
        if (change_type === "metadataonly") return;

        if (import.meta.env.DEV) {
          console.log(
            `[FileWatcher] ${affected_count} files changed in workspace`,
          );
        }

        // Invalidate React Query caches — triggers refetch
        // Note: Rust already invalidates its file cache before emitting the event
        queryClient.invalidateQueries({
          queryKey: ["files-rust", workspacePath],
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.workspaces.diffStats(workspaceId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.workspaces.diffFiles(workspaceId),
        });
      },
    );

    // Cleanup: stop watching + remove event listener
    return () => {
      isActive = false;
      setIsWatching(false);
      invoke("unwatch_workspace", { workspacePath }).catch(() => {});
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [workspacePath, workspaceId, queryClient]);

  return isWatching;
}
