import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@shared/api";
import { getRuntimeClient, runtimeForQueryClient } from "@/platform/ws";
import { queryKeys } from "@/shared/api/queryKeys";

/** The first file event confirms the host acquired the watch. */
export function useFileWatcher(workspaceId: string | null): boolean {
  const cache = useQueryClient();
  const runtime = runtimeForQueryClient(cache) ?? getRuntimeClient();
  const [watched, setWatched] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    const files = { queryKey: ["files", workspaceId] };
    const readAgain = () => {
      void cache.invalidateQueries(files);
      void cache.invalidateQueries({ queryKey: queryKeys.workspaces.environment(workspaceId) });
      void cache.invalidateQueries({ queryKey: queryKeys.workspaces.diffStats(workspaceId) });
      void cache.invalidateQueries({ queryKey: queryKeys.workspaces.diffFiles(workspaceId) });
      void cache.invalidateQueries({ queryKey: ["workspaces", "diff-file", workspaceId] });
    };
    let opening = true;
    let poll: ReturnType<typeof setInterval> | undefined;
    const pollIfVisible = () => {
      if (runtime.isConnected() && document.visibilityState === "visible") readAgain();
    };
    const disconnect = runtime.onConnectionChange((connected) => {
      if (!connected) {
        opening = true;
        setWatched(null);
      } else if (poll) pollIfVisible();
    });
    const onEvent = () => {
      if (opening) {
        opening = false;
        // An initial Files read could still be returning the tree from before acquisition.
        void cache.cancelQueries(files);
        setWatched(workspaceId);
      }
      readAgain();
    };
    const stop = runtime.follow(api.fileChanges, { workspaceId }, onEvent, {
      onReset: readAgain,
      onRefused: () => {
        setWatched(null);
        pollIfVisible();
        poll = setInterval(pollIfVisible, 5000); // Same cadence as Changes in workspace.queries.ts.
      },
    });
    return () => {
      clearInterval(poll);
      disconnect();
      stop();
      setWatched(null);
    };
  }, [cache, runtime, workspaceId]);

  return workspaceId !== null && watched === workspaceId;
}
