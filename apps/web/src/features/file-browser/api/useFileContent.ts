/**
 * Hook for reading file content from working tree.
 * Uses backend HTTP endpoint for file access (works in both Electron and browser).
 */

import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/shared/api/client";
import { ENDPOINTS } from "@/shared/config/api.config";

/**
 * Read file content from the working tree (current disk state).
 * Unlike git-based reading, this shows unsaved/uncommitted changes.
 *
 * @param workspaceId - The workspace ID for the backend route
 * @param relativePath - File path relative to the workspace root
 */
export function useFileContent(workspaceId: string | null, relativePath: string | null) {
  return useQuery({
    queryKey: ["file-content", workspaceId, relativePath],
    queryFn: async () => {
      if (!workspaceId || !relativePath) return null;
      const data = await apiClient.get<{ content: string | null }>(
        `${ENDPOINTS.WORKSPACES}/${workspaceId}/file-content`,
        { params: { path: relativePath } }
      );
      return data.content;
    },
    enabled: !!workspaceId && !!relativePath,
    staleTime: 5000,
    refetchOnWindowFocus: false,
  });
}
