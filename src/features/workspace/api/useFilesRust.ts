import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";

export interface FileTreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  modified?: string;
  children?: FileTreeNode[];
  git_status?: "modified" | "added" | "deleted" | "untracked";
}

export interface FileTreeResponse {
  files: FileTreeNode[];
  totalFiles: number;
  totalSize: number;
}

/**
 * Scan workspace files using Rust backend
 * Much faster than Node.js for large repositories
 */
async function scanWorkspaceFiles(workspacePath: string): Promise<FileTreeResponse> {
  console.log("[useFilesRust] Invoking Rust scan_workspace_files:", workspacePath);

  try {
    const result = await invoke<FileTreeResponse>("scan_workspace_files", {
      workspacePath,
    });

    console.log("[useFilesRust] Rust scan complete:", {
      totalFiles: result.totalFiles,
      totalSize: result.totalSize,
    });

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
