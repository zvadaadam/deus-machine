/**
 * Hook for scanning workspace files using Rust backend
 * Much faster than Node.js for large repositories
 */

import { useQuery } from "@tanstack/react-query";
import { invoke } from "@/platform/electron";
import type { FileTreeResponse } from "../types";

/**
 * Scan workspace files using Rust backend
 */
async function scanWorkspaceFiles(workspacePath: string): Promise<FileTreeResponse> {
  if (import.meta.env.DEV)
    console.log("[useFilesRust] Invoking Rust scan_workspace_files:", workspacePath);

  try {
    const result = await invoke<FileTreeResponse>("scan_workspace_files", {
      workspacePath,
    });

    if (import.meta.env.DEV)
      console.log("[useFilesRust] Rust scan complete:", { totalFiles: result.totalFiles });

    return result;
  } catch (error) {
    console.error("[useFilesRust] Rust scan failed:", error);
    throw error;
  }
}

/**
 * TanStack Query hook for file scanning with Rust backend
 */
export function useFilesRust(workspacePath: string | null) {
  return useQuery({
    queryKey: ["files-rust", workspacePath],
    queryFn: () =>
      workspacePath
        ? scanWorkspaceFiles(workspacePath)
        : Promise.resolve({ files: [], totalFiles: 0, totalSize: 0 }),
    enabled: !!workspacePath,
    staleTime: 30000, // 30s cache (Rust also has internal cache)
    refetchOnWindowFocus: false,
    gcTime: 5 * 60 * 1000, // 5 minutes
  });
}

/**
 * Invalidate Rust cache for a workspace
 */
export async function invalidateFileCache(workspacePath: string): Promise<void> {
  await invoke("invalidate_file_cache", { workspacePath });
}

/**
 * Clear entire Rust file cache
 */
export async function clearFileCache(): Promise<void> {
  await invoke("clear_file_cache");
}
