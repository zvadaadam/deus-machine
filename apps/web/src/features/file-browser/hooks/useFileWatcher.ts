import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@shared/api";
import { getRuntimeClient, runtimeForQueryClient } from "@/platform/ws";
import { queryKeys } from "@/shared/api/queryKeys";

/** Follow the checkout while it is on screen. A disconnected or refused follower uses polling. */
export function useFileWatcher(workspaceId: string | null): boolean {
  const cache = useQueryClient();
  const runtime = runtimeForQueryClient(cache) ?? getRuntimeClient();
  const [watched, setWatched] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    const readAgain = () => {
      void cache.invalidateQueries({ queryKey: ["files", workspaceId] });
      void cache.invalidateQueries({ queryKey: queryKeys.workspaces.environment(workspaceId) });
      void cache.invalidateQueries({ queryKey: queryKeys.workspaces.diffStats(workspaceId) });
      void cache.invalidateQueries({ queryKey: queryKeys.workspaces.diffFiles(workspaceId) });
      void cache.invalidateQueries({ queryKey: ["workspaces", "diff-file", workspaceId] });
    };
    let refused = false;
    const connectionChanged = (connected: boolean) =>
      setWatched(connected && !refused ? workspaceId : null);
    const disconnect = runtime.onConnectionChange(connectionChanged);
    const stop = runtime.follow(api.fileChanges, { workspaceId }, readAgain, {
      onReset: readAgain,
      onRefused: () => {
        refused = true;
        setWatched(null);
        readAgain();
      },
    });
    connectionChanged(runtime.isConnected());
    if (runtime.isConnected() && !refused) readAgain();
    return () => {
      disconnect();
      stop();
      setWatched(null);
    };
  }, [cache, runtime, workspaceId]);

  return workspaceId !== null && watched === workspaceId;
}
