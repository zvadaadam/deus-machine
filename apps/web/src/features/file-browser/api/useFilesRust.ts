/**
 * Hook for scanning workspace files using the Electron main process.
 * Uses IPC for fast file system access.
 */

import { useQuery } from "@tanstack/react-query";
import { invoke } from "@/platform/electron";
import type { FileTreeResponse } from "../types";

/**
 * Scan workspace files via Electron IPC
 */
async function scanWorkspaceFiles(workspacePath: string): Promise<FileTreeResponse> {
  if (import.meta.env.DEV)
    console.log("[useFilesRust] Invoking scan_workspace_files:", workspacePath);

  try {
    const result = await invoke<FileTreeResponse>("scan_workspace_files", {
      workspacePath,
    });

    if (import.meta.env.DEV)
      console.log("[useFilesRust] Scan complete:", { totalFiles: result.totalFiles });

    return result;
  } catch (error) {
    console.error("[useFilesRust] Scan failed:", error);
    throw error;
  }
}

/**
 * TanStack Query hook for file scanning via Electron IPC
 */
export function useFilesRust(workspacePath: string | null) {
  return useQuery({
    queryKey: ["files-rust", workspacePath],
    queryFn: () =>
      workspacePath
        ? scanWorkspaceFiles(workspacePath)
        : Promise.resolve({ files: [], totalFiles: 0, totalSize: 0 }),
    enabled: !!workspacePath,
    staleTime: 30000, // 30s cache
    refetchOnWindowFocus: false,
    gcTime: 5 * 60 * 1000, // 5 minutes
  });
}

/**
 * Invalidate file cache for a workspace
 */
export async function invalidateFileCache(workspacePath: string): Promise<void> {
  await invoke("invalidate_file_cache", { workspacePath });
}

/**
 * Clear entire file cache
 */
export async function clearFileCache(): Promise<void> {
  await invoke("clear_file_cache");
}
