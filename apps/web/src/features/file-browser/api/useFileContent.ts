/**
 * Hook for reading a file's text from the working tree.
 * Works in both desktop and relay mode through the WebSocket connection.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "@shared/api";
import { call } from "@/platform/ws";

/**
 * Read file content from the working tree (current disk state).
 * Unlike git-based reading, this shows unsaved/uncommitted changes.
 *
 * @param workspaceId - The workspace ID
 * @param relativePath - File path relative to the workspace root
 */
export function useFileContent(workspaceId: string | null, relativePath: string | null) {
  return useQuery({
    queryKey: ["file-content", workspaceId, relativePath],
    queryFn: async () => {
      if (!workspaceId || !relativePath) return null;
      const { content } = await call(api.fileContent, { workspaceId, path: relativePath });
      return content;
    },
    enabled: !!workspaceId && !!relativePath,
    staleTime: 5000,
    refetchOnWindowFocus: false,
  });
}
