/**
 * The workspace's file tree, scanned by the backend (.gitignore-aware, cached)
 * on this computer or in the workspace's cloud sandbox.
 */

import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "@shared/api";
import { call, onConnectionChange } from "@/platform/ws";
import type { FileTreeResponse } from "../types";

export function useFiles(workspaceId: string | null, options?: { enabled?: boolean }) {
  const enabled = !!workspaceId && (options?.enabled ?? true);
  const query = useQuery({
    queryKey: ["files", workspaceId],
    queryFn: (): Promise<FileTreeResponse> =>
      workspaceId
        ? call(api.workspaceFiles, { workspaceId })
        : Promise.resolve({ files: [], totalFiles: 0, totalSize: 0 }),
    enabled,
    staleTime: 30000, // 30s cache
    refetchOnWindowFocus: true,
    gcTime: 5 * 60 * 1000, // 5 minutes
  });
  const { refetch } = query;
  useEffect(
    () =>
      onConnectionChange((connected) => {
        if (connected && enabled) void refetch();
      }),
    [enabled, refetch, workspaceId]
  );
  return query;
}
