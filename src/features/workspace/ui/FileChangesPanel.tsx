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
            <div className="space-y-1">
              {fileChanges.map((file) => {
                // Guard against invalid file paths
                if (!file.file || file.file.trim() === '') {
                  console.warn('Invalid file path detected:', file);
                  return null;
                }

                const pathParts = file.file.split('/').filter(part => part.length > 0);
                const filename = pathParts.pop() || file.file;

                // Additional guard: if filename is empty or whitespace-only
                if (!filename || filename.trim() === '') {
                  console.warn('Invalid or suspicious filename detected:', file.file);
                  return null;
                }

                /**
                 * Smart path truncation with context
                 *
                 * Strategy: Show first folder (src/tests/docs) + last parent + filename
                 * - Root files: filename.ext
                 * - 1 level: src/filename.ext
                 * - 2+ levels: src/…/parent/filename.ext
                 *
                 * Why: First folder gives critical context (source vs tests vs config)
                 */
                let displayPath = '';
                if (pathParts.length === 0) {
                  // No directory (root file)
                  displayPath = '';
                } else if (pathParts.length === 1) {
                  // One level deep (e.g., src/file.tsx)
                  displayPath = pathParts[0] + '/';
                } else {
                  // Multiple levels: show firstFolder/…/lastParent/
                  const firstFolder = pathParts[0];
                  const lastParent = pathParts[pathParts.length - 1];
                  displayPath = `${firstFolder}/…/${lastParent}/`;
                }

                return (
                  <div
                    key={file.file}
                    className="flex items-center justify-between px-2.5 py-1.5 rounded cursor-pointer group hover:bg-muted/20 transition-colors duration-200"
                    onClick={() => handleFileClick(file.file)}
                    title={file.file}
                  >
                    <div className="flex-1 min-w-0 font-mono">
                      <span className="text-[11px] text-muted-foreground/50">
                        {displayPath}
                      </span>
                      <span className="text-[11px] text-foreground/90 group-hover:text-foreground transition-colors duration-200">
                        {filename}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0 ml-3 font-mono tabular-nums min-w-[60px] justify-end">
                      {file.additions > 0 && (
                        <span className="text-[10px] font-semibold text-success/90">
                          +{file.additions}
                        </span>
                      )}
                      {file.deletions > 0 && (
                        <span className="text-[10px] font-semibold text-destructive/90">
                          -{file.deletions}
                        </span>
                      )}
                    </div>
                  </div>
                );
              }).filter(Boolean)}
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
