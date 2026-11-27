/**
 * Hook for reading a file's text from the working tree.
 * Works in both desktop and relay mode through the WebSocket connection.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "@shared/api";
import { call } from "@/platform/ws";

/** Full-screen visits recheck the checkout on open. Desktop tabs can reuse a recent read. */
export function useFileContent(
  workspaceId: string | null,
  relativePath: string | null,
  refreshOnOpen = false
) {
  return useQuery({
    queryKey: ["file-content", workspaceId, relativePath],
    queryFn: async () => {
      if (!workspaceId || !relativePath) return null;
      const { content } = await call(api.fileContent, { workspaceId, path: relativePath });
      return content;
    },
    enabled: !!workspaceId && !!relativePath,
    staleTime: refreshOnOpen ? 0 : 5000,
    refetchOnWindowFocus: false,
  });
}
