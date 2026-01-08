import { FolderOpen, Search, Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyMedia, EmptyDescription } from "@/components/ui/empty";
import { useFilesRust, invalidateFileCache } from "../api/useFilesRust";
import { FileTree } from "./components/FileTree";
import type { Workspace } from "@/shared/types";
import type { FileTreeNode } from "../types";

interface FileBrowserPanelProps {
  selectedWorkspace: Workspace | null;
  onFileClick?: (path: string) => void;
}

/**
 * FileBrowserPanel - Browse all files in workspace directory
 * Uses Rust-based file scanning for native performance
 * - Fast .gitignore-aware file scanning via Rust
 * - Recursive tree view with expand/collapse
 * - Real-time search filtering
 * - 30s cache with manual refresh
 */
export function FileBrowserPanel({
  selectedWorkspace,
  onFileClick: onFileClickProp,
}: FileBrowserPanelProps) {
  const [searchQuery, setSearchQuery] = useState("");

  // Use Rust-based file scanning
  const workspacePath = selectedWorkspace
    ? `${selectedWorkspace.root_path}/.conductor/${selectedWorkspace.directory_name}`
    : null;

  const { data, isLoading, error, refetch } = useFilesRust(workspacePath);

  const handleRefresh = async () => {
    if (workspacePath) {
      // Invalidate Rust cache and refetch
      await invalidateFileCache(workspacePath);
      refetch();
    }
  };

  const handleFileClick = (path: string) => {
    if (onFileClickProp) {
      onFileClickProp(path);
    } else {
      if (import.meta.env.DEV) console.log("File clicked:", path);
    }
  };

  // Filter files based on search (recursive search)
  const filterNodes = (nodes: FileTreeNode[]): FileTreeNode[] => {
    if (!searchQuery) return nodes;

    return nodes.reduce((acc, node) => {
      if (node.name.toLowerCase().includes(searchQuery.toLowerCase())) {
        acc.push(node);
      } else if (node.children) {
        const filteredChildren = filterNodes(node.children);
        if (filteredChildren.length > 0) {
          acc.push({ ...node, children: filteredChildren });
        }
      }
      return acc;
    }, [] as FileTreeNode[]);
  };

  const filteredFiles = data ? filterNodes(data.files) : [];

  if (!selectedWorkspace) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-8">
        <Empty className="border-0">
          <EmptyHeader>
            <EmptyMedia>
              <FolderOpen className="text-muted-foreground/40 h-16 w-16" aria-hidden="true" />
            </EmptyMedia>
            <EmptyDescription>No workspace selected</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-8">
        <Loader2 className="text-primary h-8 w-8 animate-spin" />
        <p className="text-muted-foreground mt-3 text-xs">Scanning files with Rust...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-8">
        <Empty className="border-0">
          <EmptyHeader>
            <EmptyMedia>
              <FolderOpen className="text-muted-foreground/40 h-16 w-16" aria-hidden="true" />
            </EmptyMedia>
            <EmptyDescription>
              Error: {error instanceof Error ? error.message : "Unknown error"}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Search Bar + Refresh */}
      <div className="border-border/30 flex flex-shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <div className="relative flex-1">
          <Search className="text-muted-foreground/40 absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2" />
          <Input
            type="text"
            placeholder="Search files..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="placeholder:text-muted-foreground/50 h-9 pl-7 text-xs"
          />
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9"
          onClick={handleRefresh}
          title="Refresh files"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* File Count Stats */}
      <div className="border-border/20 flex flex-shrink-0 items-center justify-between border-b px-3 py-2">
        <span className="text-muted-foreground/60 text-xs font-medium">
          {data?.totalFiles || 0} files
        </span>
        {data?.totalSize && (
          <span className="text-muted-foreground/40 font-mono text-xs tabular-nums">
            {formatTotalSize(data.totalSize)}
          </span>
        )}
      </div>

      {/* File Tree */}
      <div className="scrollbar-vibrancy flex-1 overflow-y-auto p-2">
        {filteredFiles.length > 0 ? (
          <FileTree nodes={filteredFiles} onFileClick={handleFileClick} />
        ) : (
          <div className="p-8">
            <Empty className="border-0">
              <EmptyHeader>
                <EmptyMedia>
                  <FolderOpen className="text-muted-foreground/40 h-16 w-16" aria-hidden="true" />
                </EmptyMedia>
                <EmptyDescription>
                  {searchQuery ? "No files match your search" : "No files found"}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        )}
      </div>
    </div>
  );
}

function formatTotalSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
