import { useState, useRef } from "react";
import { Monitor, Sparkles, FileCode } from "lucide-react";
import { EmptyState } from "@/components/ui";
import { useFileChanges, useDevServers } from "@/features/workspace/api";
import { useUIStore } from "@/shared/stores/uiStore";
import type { Workspace } from "@/shared/types";

interface FileChangesPanelProps {
  selectedWorkspace: Workspace | null;
}

/**
 * File Changes Panel
 * Shows dev servers and file changes for the selected workspace
 */
export function FileChangesPanel({ selectedWorkspace }: FileChangesPanelProps) {
  const [loadingDiff, setLoadingDiff] = useState(false);
  const currentFileRef = useRef<string | null>(null);
  const { openDiffModal } = useUIStore();

  // Query data
  const { data: fileChanges = [] } = useFileChanges(selectedWorkspace?.id || null);
  const { data: devServers = [] } = useDevServers(selectedWorkspace?.id || null);

  /**
   * Load and display diff for a specific file
   * Prevents race conditions by tracking the current file being loaded
   */
  async function handleFileClick(file: string) {
    if (!selectedWorkspace) return;

    // Track this file as the current one being loaded
    currentFileRef.current = file;

    setLoadingDiff(true);
    openDiffModal(file, 'Loading diff...'); // Open with loading message

    try {
      const { WorkspaceService } = await import('@/features/workspace/api/workspace.service');
      const data = await WorkspaceService.fetchFileDiff(selectedWorkspace.id, file);

      // Ignore stale responses - only update if this is still the current file
      if (currentFileRef.current !== file) return;

      openDiffModal(file, data.diff || 'No diff available'); // Update with actual diff
    } catch (error) {
      console.error('Failed to load diff:', error);

      // Ignore stale errors
      if (currentFileRef.current !== file) return;

      openDiffModal(file, 'Error loading diff');
    } finally {
      setLoadingDiff(false);
    }
  }

  return (
    <div className="h-full flex flex-col">
      {/* Dev Servers Section */}
      {selectedWorkspace && devServers.length > 0 && (
        <div className="border-b border-border/50 bg-background/30">
          <div className="px-4 py-2.5 sticky top-0 z-10 bg-background/50 backdrop-blur-sm border-b border-border/30">
            <h3 className="text-caption font-semibold text-muted-foreground uppercase tracking-wider">Dev Servers</h3>
          </div>
          <div className="p-3 space-y-2">
            {devServers.map((server, index) => (
              <a
                key={index}
                href={server.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 p-2.5 rounded-lg no-underline group elevation-1 hover:elevation-2 [@media(hover:hover)and(pointer:fine)]:hover:bg-sidebar-accent/60 [@media(hover:hover)and(pointer:fine)]:transition-[background-color,box-shadow] [@media(hover:hover)and(pointer:fine)]:duration-200 [@media(hover:hover)and(pointer:fine)]:ease-out"
                title={`Open ${server.name} in browser`}
              >
                <div className="flex-shrink-0 w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center">
                  <Monitor className="w-4 h-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-body-sm font-medium truncate [@media(hover:hover)and(pointer:fine)]:group-hover:text-primary [@media(hover:hover)and(pointer:fine)]:transition-colors [@media(hover:hover)and(pointer:fine)]:duration-200 [@media(hover:hover)and(pointer:fine)]:ease">{server.name}</div>
                  <div className="text-caption text-muted-foreground truncate font-mono">{server.url}</div>
                </div>
                <div className="h-2 w-2 rounded-full bg-success flex-shrink-0" />
              </a>
            ))}
          </div>
        </div>
      )}

      {/* File Changes */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-4 py-2.5 sticky top-0 z-10 border-b border-border/50 bg-background/50 backdrop-blur-sm">
          <h3 className="text-caption font-semibold text-muted-foreground uppercase tracking-wider">File Changes</h3>
        </div>
        <div className="p-3">
          {selectedWorkspace && fileChanges.length > 0 ? (
            <div className="space-y-1">
              {fileChanges.map((file, index) => (
                <div
                  key={index}
                  className="flex items-center justify-between p-2.5 rounded-lg cursor-pointer group elevation-1 hover:elevation-2 [@media(hover:hover)and(pointer:fine)]:hover:bg-sidebar-accent/60 [@media(hover:hover)and(pointer:fine)]:transition-[background-color,box-shadow] [@media(hover:hover)and(pointer:fine)]:duration-200 [@media(hover:hover)and(pointer:fine)]:ease-out"
                  onClick={() => handleFileClick(file.file)}
                  title="Click to view diff"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-body-sm font-medium truncate [@media(hover:hover)and(pointer:fine)]:group-hover:text-primary [@media(hover:hover)and(pointer:fine)]:transition-colors [@media(hover:hover)and(pointer:fine)]:duration-200 [@media(hover:hover)and(pointer:fine)]:ease">{file.file.split('/').pop()}</div>
                    <div className="text-caption text-muted-foreground truncate font-mono">{file.file}</div>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs flex-shrink-0 ml-3">
                    {file.additions > 0 && (
                      <span className="text-success font-semibold px-1.5 py-0.5 bg-success/10 rounded">+{file.additions}</span>
                    )}
                    {file.deletions > 0 && (
                      <span className="text-destructive font-semibold px-1.5 py-0.5 bg-destructive/10 rounded">-{file.deletions}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : selectedWorkspace ? (
            <div className="p-8">
              <EmptyState
                icon={<Sparkles  />}
                description="No file changes detected"
              />
            </div>
          ) : (
            <div className="p-8">
              <EmptyState
                icon={<FileCode  />}
                description="Select a workspace to view file changes"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
