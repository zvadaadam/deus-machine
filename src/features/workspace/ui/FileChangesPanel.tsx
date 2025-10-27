import { useRef } from "react";
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
  const currentFileRef = useRef<string | null>(null);
  const { openDiffModal } = useUIStore();

  // Query data with conditional polling based on session status
  const { data: fileChanges = [] } = useFileChanges(
    selectedWorkspace?.id || null,
    selectedWorkspace?.session_status
  );
  const { data: devServers = [] } = useDevServers(selectedWorkspace?.id || null);

  /**
   * Load and display diff for a specific file
   * Prevents race conditions by tracking the current file being loaded
   */
  async function handleFileClick(file: string) {
    if (!selectedWorkspace) return;

    // Track this file as the current one being loaded
    currentFileRef.current = file;

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
    }
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Dev Servers Section */}
      {selectedWorkspace && devServers.length > 0 && (
        <div className="border-b border-border/50 bg-background/30">
          <div className="px-4 py-2.5 sticky top-0 z-10 bg-background/50 backdrop-blur-sm border-b border-border/30">
            <h3 className="text-caption font-semibold text-muted-foreground uppercase tracking-wider">Dev Servers</h3>
          </div>
          <div className="p-3 space-y-2">
            {devServers.map((server) => (
              <a
                key={server.url}
                href={server.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 p-2.5 rounded-lg no-underline group elevation-1 hover:elevation-2 hover-interactive"
                title={`Open ${server.name} in browser`}
              >
                <div className="flex-shrink-0 w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center">
                  <Monitor className="w-4 h-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-body-sm font-medium truncate group-hover:hover-primary-text">{server.name}</div>
                  <div className="text-caption text-muted-foreground truncate font-mono">{server.url}</div>
                </div>
                <div className="h-2 w-2 rounded-full bg-success flex-shrink-0" />
              </a>
            ))}
          </div>
        </div>
      )}

      {/* File Changes */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="p-2">
          {selectedWorkspace && fileChanges.length > 0 ? (
            <div className="space-y-0.5">
              {fileChanges.map((file) => {
                const pathParts = file.file.split('/');
                const filename = pathParts.pop() || file.file;

                // Smart path truncation: show …/parent/filename for long paths
                let displayPath = '';
                if (pathParts.length === 0) {
                  // No directory (root file)
                  displayPath = '';
                } else if (pathParts.length === 1) {
                  // One level deep (e.g., src/file.tsx)
                  displayPath = pathParts[0] + '/';
                } else {
                  // Multiple levels: show …/lastParent/
                  const lastParent = pathParts[pathParts.length - 1];
                  displayPath = `…/${lastParent}/`;
                }

                return (
                  <div
                    key={file.file}
                    className="flex items-center justify-between px-2.5 py-2 rounded-lg cursor-pointer group hover:bg-muted/30 transition-colors duration-200"
                    onClick={() => handleFileClick(file.file)}
                    title={file.file}
                  >
                    <div className="flex-1 min-w-0 font-mono">
                      <span className="text-xs text-muted-foreground/60">
                        {displayPath}
                      </span>
                      <span className="text-xs text-foreground group-hover:text-primary transition-colors duration-200">
                        {filename}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0 ml-2">
                      {file.additions > 0 && (
                        <span className="inline-flex items-center px-1 py-0.5 rounded text-[10px] font-medium border border-success/30 bg-success/10 text-success">
                          +{file.additions}
                        </span>
                      )}
                      {file.deletions > 0 && (
                        <span className="inline-flex items-center px-1 py-0.5 rounded text-[10px] font-medium border border-destructive/30 bg-destructive/10 text-destructive">
                          -{file.deletions}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
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
