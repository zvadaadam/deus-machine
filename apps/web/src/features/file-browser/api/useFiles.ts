/**
 * Hook for scanning workspace files via the q:request protocol.
 * The backend handles .gitignore-aware file scanning with caching.
 */

import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { sendRequest, sendMutate, onConnectionChange } from "@/platform/ws";
import type { FileTreeResponse } from "../types";

/**
 * Scan workspace files via q:request
 */
async function scanWorkspaceFiles(workspaceId: string): Promise<FileTreeResponse> {
  return sendRequest<FileTreeResponse>("workspaceFiles", { workspaceId });
}

/**
 * TanStack Query hook for file scanning via q:request
 */
export function useFiles(workspaceId: string | null, options?: { enabled?: boolean }) {
  const enabled = !!workspaceId && (options?.enabled ?? true);
  const query = useQuery({
    queryKey: ["files", workspaceId],
    queryFn: () =>
      workspaceId
        ? scanWorkspaceFiles(workspaceId)
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

/**
 * Invalidate file cache for a workspace via q:mutate
 */
export async function invalidateFileCache(workspaceId: string): Promise<void> {
  const result = await sendMutate("invalidateFileCache", { workspaceId });
  if (!result.success) throw new Error(result.error || "Failed to invalidate file cache");
}
