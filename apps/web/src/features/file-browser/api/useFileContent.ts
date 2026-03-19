/**
 * Hook for reading file content from working tree
 * Uses IPC command for native file access
 */

import { useQuery } from "@tanstack/react-query";
import { invoke } from "@/platform/electron";

/**
 * Read file content from the working tree (current disk state)
 * Unlike git-based reading, this shows unsaved/uncommitted changes
 */
export function useFileContent(filePath: string | null) {
  return useQuery({
    queryKey: ["file-content", filePath],
    queryFn: async () => {
      if (!filePath) return null;

      if (import.meta.env.DEV) {
        console.log("[useFileContent] Reading file:", filePath);
      }

      const content = await invoke<string>("read_text_file", { filePath });
      return content;
    },
    enabled: !!filePath,
    staleTime: 5000, // 5s cache - file could change
    refetchOnWindowFocus: false,
  });
}
