/**
 * Hook for scanning workspace files via the q:request protocol.
 * The backend handles .gitignore-aware file scanning with caching.
 */

import { useQuery } from "@tanstack/react-query";
import { sendRequest, sendMutate } from "@/platform/ws";
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
  return useQuery({
    queryKey: ["files", workspaceId],
    queryFn: () =>
      workspaceId
        ? scanWorkspaceFiles(workspaceId)
        : Promise.resolve({ files: [], totalFiles: 0, totalSize: 0 }),
    enabled: !!workspaceId && (options?.enabled ?? true),
    staleTime: 30000, // 30s cache
    refetchOnWindowFocus: false,
    gcTime: 5 * 60 * 1000, // 5 minutes
  });
}

/**
 * Invalidate file cache for a workspace via q:mutate
 */
export async function invalidateFileCache(workspaceId: string): Promise<void> {
  const result = await sendMutate("invalidateFileCache", { workspaceId });
  if (!result.success) throw new Error(result.error || "Failed to invalidate file cache");
}
