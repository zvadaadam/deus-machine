/**
 * Workspace Init Events Hook
 *
 * Listens for workspace initialization progress events from Tauri
 * and invalidates React Query cache on terminal states (done/error).
 *
 * Event flow:
 * 1. Backend's initializeWorkspace() emits OPENDEVS_WORKSPACE_PROGRESS:{json} to stdout
 * 2. Rust backend.rs parses the prefix and emits Tauri event "workspace:progress"
 * 3. This hook receives the event and invalidates workspace queries
 *
 * Memory leak prevention: Stores promise (not unlisten fn) — same pattern as useSessionEvents.
 */

import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/shared/api/queryKeys";
import { isTauriEnv } from "@/platform/tauri";

interface WorkspaceProgressEvent {
  workspaceId: string;
  step: string;
  label: string;
}

/**
 * Listen for workspace initialization progress events.
 * On terminal states (done, error), invalidates workspace queries
 * so the sidebar reflects the new state immediately.
 */
export function useWorkspaceInitEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!isTauriEnv) return;

    const unlistenPromise = listen<WorkspaceProgressEvent>(
      "workspace:progress",
      (event) => {
        const { step } = event.payload;

        if (import.meta.env.DEV) {
          console.log("[Events] Workspace progress:", event.payload);
        }

        // Terminal states: clear any diff caches that may have been populated
        // during init (race window between state→ready and git checkout -- .),
        // then invalidate workspace list to pick up the final state.
        if (step === "done" || step.startsWith("error")) {
          const { workspaceId } = event.payload;

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
      }
    );

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [queryClient]);
}
