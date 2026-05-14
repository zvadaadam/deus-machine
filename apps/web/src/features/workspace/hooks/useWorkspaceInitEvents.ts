/**
 * Workspace Init Events Hook
 *
 * Listens for workspace initialization progress events from the main process,
 * patches in-flight sidebar state, and invalidates React Query cache on
 * terminal states (done/error).
 *
 * Event flow:
 * 1. Backend's initializeWorkspace() emits DEUS_WORKSPACE_PROGRESS:{json} to stdout
 * 2. Electron main process (backend-process.ts) parses the prefix and emits IPC event "workspace:progress"
 * 3. This hook receives the event and invalidates workspace queries
 *
 * Memory leak prevention: Stores promise (not unlisten fn) — same pattern as other IPC listeners.
 */

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/shared/api/queryKeys";
import { WORKSPACE_PROGRESS } from "@shared/events";
import { capabilities, native } from "@/platform";
import { onEvent } from "@/platform/ws";
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
    const handleProgress = (data: { workspaceId: string; step: string; label: string }) => {
      const { step, workspaceId } = data;

      if (import.meta.env.DEV) {
        console.log("[Events] Workspace progress:", data);
      }

      queryClient.setQueriesData<RepoGroup[]>({ queryKey: ["workspaces", "by-repo"] }, (old) =>
        applyWorkspaceProgressToRepoGroups(old, data)
      );

      // Terminal states: clear any diff caches that may have been populated
      // during init (race window between state->ready and git checkout -- .),
      // then invalidate workspace list to pick up the final state.
      if (isTerminalWorkspaceProgressStep(step)) {
        queryClient.removeQueries({
          queryKey: queryKeys.workspaces.diffStats(workspaceId),
        });
        queryClient.removeQueries({
          queryKey: queryKeys.workspaces.diffFiles(workspaceId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.workspaces.all,
        });
      }
    };

    const unlistenNative = capabilities.ipcEventListeners
      ? native.events.on(WORKSPACE_PROGRESS, handleProgress)
      : undefined;
    const unlistenWs = capabilities.ipcEventListeners
      ? undefined
      : onEvent((event, data) => {
          if (event === WORKSPACE_PROGRESS) {
            handleProgress(data as { workspaceId: string; step: string; label: string });
          }
        });

    return () => {
      unlistenNative?.();
      unlistenWs?.();
    };
  }, [queryClient]);
}
