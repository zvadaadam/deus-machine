/**
 * Hook for scanning workspace files via the backend HTTP endpoint.
 * The backend handles .gitignore-aware file scanning with caching.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/shared/api/client";
import { ENDPOINTS } from "@/shared/config/api.config";
import type { FileTreeResponse } from "../types";

/**
 * Scan workspace files via backend HTTP
 */
async function scanWorkspaceFiles(workspaceId: string): Promise<FileTreeResponse> {
  return apiClient.get<FileTreeResponse>(ENDPOINTS.WORKSPACE_FILES(workspaceId));
}

/**
 * TanStack Query hook for file scanning via backend HTTP
 */
export function useFiles(workspaceId: string | null) {
  return useQuery({
    queryKey: ["files", workspaceId],
    queryFn: () =>
      workspaceId
        ? scanWorkspaceFiles(workspaceId)
        : Promise.resolve({ files: [], totalFiles: 0, totalSize: 0 }),
    enabled: !!workspaceId,
    staleTime: 30000, // 30s cache
    refetchOnWindowFocus: false,
    gcTime: 5 * 60 * 1000, // 5 minutes
  });
}

/**
 * Invalidate file cache for a workspace via backend HTTP
 */
export async function invalidateFileCache(workspaceId: string): Promise<void> {
  await apiClient.post(ENDPOINTS.WORKSPACE_FILES_INVALIDATE(workspaceId));
}

/**
 * Clear file cache — invalidates all file queries in the React Query cache
 */
export function useClearFileCache() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["files"] });
}
