import { FolderOpen, Search, Loader2, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui';
import { useFilesRust, invalidateFileCache } from '../api/useFilesRust';
import { FileTree } from './components/FileTree';
import type { Workspace } from '@/shared/types';
import type { FileTreeNode } from '../api/useFilesRust';

interface FileBrowserPanelProps {
  selectedWorkspace: Workspace | null;
}

/**
 * FileBrowserPanel - Browse all files in workspace directory
 * Uses Rust-based file scanning for native performance
 * - Fast .gitignore-aware file scanning via Rust
 * - Recursive tree view with expand/collapse
 * - Real-time search filtering
 * - 30s cache with manual refresh
 */
export function FileBrowserPanel({ selectedWorkspace }: FileBrowserPanelProps) {
  const [searchQuery, setSearchQuery] = useState('');

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
    console.log('File clicked:', path);
    // TODO: Open file viewer or send to chat
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
      <div className="h-full flex flex-col items-center justify-center p-8">
        <EmptyState
          icon={<FolderOpen />}
          description="No workspace selected"
        />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-xs text-muted-foreground mt-3">Scanning files with Rust...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8">
        <EmptyState
          icon={<FolderOpen />}
          description={`Error: ${error instanceof Error ? error.message : 'Unknown error'}`}
        />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Search Bar + Refresh */}
      <div className="px-3 py-2 border-b border-border/30 flex items-center gap-2 flex-shrink-0">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50" />
          <Input
            type="text"
            placeholder="Search files..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 pl-8 text-sm"
          />
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={handleRefresh}
          title="Refresh files"
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {/* File Count */}
      <div className="px-3 py-1.5 border-b border-border/20 flex items-center justify-between flex-shrink-0">
        <span className="text-xs text-muted-foreground/70">
          {data?.totalFiles || 0} files
        </span>
        {data?.totalSize && (
          <span className="text-xs text-muted-foreground/50 font-mono tabular-nums">
            {formatTotalSize(data.totalSize)}
          </span>
        )}
      </div>

      {/* File Tree */}
      <div className="flex-1 overflow-y-auto p-2">
        {filteredFiles.length > 0 ? (
          <FileTree nodes={filteredFiles} onFileClick={handleFileClick} />
        ) : (
          <div className="p-8">
            <EmptyState
              icon={<FolderOpen />}
              description={searchQuery ? "No files match your search" : "No files found"}
            />
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
