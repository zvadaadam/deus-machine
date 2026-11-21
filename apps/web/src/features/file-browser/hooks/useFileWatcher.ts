import { useEffect, useState } from "react";
import { useQueryClient, type InvalidateOptions } from "@tanstack/react-query";
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
    const readAgain = (options?: InvalidateOptions) => {
      for (const queryKey of [
        files.queryKey,
        queryKeys.workspaces.environment(workspaceId),
        queryKeys.workspaces.diffStats(workspaceId),
        queryKeys.workspaces.diffFiles(workspaceId),
        ["workspaces", "diff-file", workspaceId],
      ])
        void cache.invalidateQueries({ queryKey }, options);
    };
    let opening = true;
    let poll: ReturnType<typeof setInterval> | undefined;
    const pollIfVisible = (options?: InvalidateOptions) => {
      if (runtime.isConnected() && document.visibilityState === "visible") readAgain(options);
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
        // Same cadence as Changes in workspace.queries.ts. Let a slower read finish.
        poll = setInterval(() => pollIfVisible({ cancelRefetch: false }), 5000);
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
