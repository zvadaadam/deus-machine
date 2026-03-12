/**
 * Workspace Init Events Hook
 *
 * Listens for workspace initialization progress events from Tauri,
 * patches in-flight sidebar state, and invalidates React Query cache on
 * terminal states (done/error).
 *
 * Event flow:
 * 1. Backend's initializeWorkspace() emits OPENDEVS_WORKSPACE_PROGRESS:{json} to stdout
 * 2. Rust backend.rs parses the prefix and emits Tauri event "workspace:progress"
 * 3. This hook receives the event and invalidates workspace queries
 *
 * Memory leak prevention: Stores promise (not unlisten fn) — same pattern as useSessionEvents.
 */

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/shared/api/queryKeys";
import { isTauriEnv, listen, createListenerGroup, WORKSPACE_PROGRESS } from "@/platform/tauri";
import type { RepoGroup } from "@shared/types/workspace";
import {
  applyWorkspaceProgressToRepoGroups,
  isTerminalWorkspaceProgressStep,
} from "../lib/dashboardRealtime";

/**
 * Listen for workspace initialization progress events.
 * On terminal states (done, error), invalidates workspace queries
 * so the sidebar reflects the new state immediately.
 */
export function useWorkspaceInitEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!isTauriEnv) return;

    const listeners = createListenerGroup();

    listeners.register(
      listen(WORKSPACE_PROGRESS, (event) => {
        const { step, workspaceId } = event.payload;

        if (import.meta.env.DEV) {
          console.log("[Events] Workspace progress:", event.payload);
        }

        queryClient.setQueriesData<RepoGroup[]>({ queryKey: ["workspaces", "by-repo"] }, (old) =>
          applyWorkspaceProgressToRepoGroups(old, event.payload)
        );

        // Terminal states: clear any diff caches that may have been populated
        // during init (race window between state→ready and git checkout -- .),
        // then invalidate workspace list to pick up the final state.
        if (isTerminalWorkspaceProgressStep(step)) {
          queryClient.removeQueries({
            queryKey: queryKeys.workspaces.diffStats(workspaceId),
          });
          queryClient.removeQueries({
            queryKey: queryKeys.workspaces.diffFiles(workspaceId),
          });
          queryClient.removeQueries({
            queryKey: queryKeys.workspaces.uncommittedFiles(workspaceId),
          });
          queryClient.invalidateQueries({
            queryKey: queryKeys.workspaces.all,
          });
        }
      })
    );

    return () => listeners.cleanup();
  }, [queryClient]);
}
