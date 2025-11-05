import { useRef, useEffect, useCallback } from "react";
import { Monitor, Sparkles, FileCode } from "lucide-react";
import { Empty, EmptyHeader, EmptyMedia, EmptyDescription } from "@/components/ui/empty";
import { useFileChanges, useDevServers } from "@/features/workspace/api";
import type { Workspace } from "@/shared/types";

interface FileChangesPanelProps {
  selectedWorkspace: Workspace | null;
  onOpenDiffTab?: (data: {
    file: string;
    diff: string;
    additions: number;
    deletions: number;
  }) => void;
  onUpdateDiffTab?: (
    filePath: string,
    updates: { diff?: string; additions?: number; deletions?: number }
  ) => void;
  selectedFilePath?: string; // Currently selected file for highlighting
}

/**
 * File Changes Panel
 * Shows dev servers and file changes for the selected workspace
 */
export function FileChangesPanel({
  selectedWorkspace,
  onOpenDiffTab,
  onUpdateDiffTab,
  selectedFilePath,
}: FileChangesPanelProps) {
  const currentFileRef = useRef<string | null>(null);

  // Query data with conditional polling based on session status
  const { data: fileChanges = [] } = useFileChanges(
    selectedWorkspace?.id || null,
    selectedWorkspace?.session_status
  );
  const { data: devServers = [] } = useDevServers(selectedWorkspace?.id || null);

  /**
   * Load and display diff for a specific file as an inline tab
   * Prevents race conditions by tracking the current file being loaded
   */
  const handleFileClick = useCallback(
    async (file: string, additions: number, deletions: number) => {
      if (!selectedWorkspace || !onOpenDiffTab || !onUpdateDiffTab) return;

      // Track this file as the current one being loaded
      currentFileRef.current = file;

      // Open tab with loading message
      onOpenDiffTab({
        file,
        diff: "Loading diff...",
        additions: 0,
        deletions: 0,
      });

      try {
        const { WorkspaceService } = await import("@/features/workspace/api/workspace.service");
        const data = await WorkspaceService.fetchFileDiff(selectedWorkspace.id, file);

        // Ignore stale responses - only update if this is still the current file
        if (currentFileRef.current !== file) return;

        // Update tab with actual diff data
        onUpdateDiffTab(file, {
          diff: data.diff || "No diff available",
          additions,
          deletions,
        });
      } catch (error) {
        console.error("Failed to load diff:", error);

        // Ignore stale errors
        if (currentFileRef.current !== file) return;

        onUpdateDiffTab(file, {
          diff: "Error loading diff",
        });
      }
    },
    [selectedWorkspace, onOpenDiffTab, onUpdateDiffTab]
  );

  /**
   * Auto-load diff when file is restored from persistence
   * This happens when user switches back to Changes tab and we restore their last viewed file
   */
  useEffect(() => {
    if (!selectedFilePath || !selectedWorkspace || !fileChanges.length) return;

    // Find the file in the current changes list
    const fileData = fileChanges.find((f) => f.file === selectedFilePath);
    if (!fileData) return;

    // If this file is selected but we haven't loaded it yet, load it now
    // (This happens when restoring from persistence)
    if (currentFileRef.current !== selectedFilePath) {
      handleFileClick(fileData.file, fileData.additions, fileData.deletions);
    }
  }, [selectedFilePath, selectedWorkspace?.id, fileChanges, handleFileClick]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Dev Servers Section */}
      {selectedWorkspace && devServers.length > 0 && (
        <div className="border-border/50 bg-background/30 border-b">
          <div className="bg-background/50 border-border/30 sticky top-0 z-10 border-b px-4 py-2.5 backdrop-blur-sm">
            <h3 className="text-caption text-muted-foreground font-semibold tracking-wider uppercase">
              Dev Servers
            </h3>
          </div>
          <div className="space-y-2 p-3">
            {devServers.map((server) => (
              <a
                key={server.url}
                href={server.url}
                target="_blank"
                rel="noopener noreferrer"
                className="group hover-interactive flex items-center gap-3 rounded-lg p-2.5 no-underline shadow-sm hover:shadow"
                title={`Open ${server.name} in browser`}
              >
                <div className="bg-primary/10 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md">
                  <Monitor className="text-primary h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-body-sm group-hover:hover-primary-text truncate font-medium">
                    {server.name}
                  </div>
                  <div className="text-caption text-muted-foreground truncate font-mono">
                    {server.url}
                  </div>
                </div>
                <div className="bg-success h-2 w-2 flex-shrink-0 rounded-full" />
              </a>
            ))}
          </div>
        </div>
      )}

      {/* File Changes */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="py-2">
          {selectedWorkspace && fileChanges.length > 0 ? (
            <div className="space-y-1">
              {fileChanges
                .map((file) => {
                  // Guard against invalid file paths
                  if (!file.file || file.file.trim() === "") {
                    console.warn("Invalid file path detected:", file);
                    return null;
                  }

                  const pathParts = file.file.split("/").filter((part) => part.length > 0);
                  const filename = pathParts.pop() || file.file;

                  // Additional guard: if filename is empty or whitespace-only
                  if (!filename || filename.trim() === "") {
                    console.warn("Invalid or suspicious filename detected:", file.file);
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
                  let displayPath = "";
                  if (pathParts.length === 0) {
                    // No directory (root file)
                    displayPath = "";
                  } else if (pathParts.length === 1) {
                    // One level deep (e.g., src/file.tsx)
                    displayPath = pathParts[0] + "/";
                  } else {
                    // Multiple levels: show firstFolder/…/lastParent/
                    const firstFolder = pathParts[0];
                    const lastParent = pathParts[pathParts.length - 1];
                    displayPath = `${firstFolder}/…/${lastParent}/`;
                  }

                  const isSelected = file.file === selectedFilePath;

                  return (
                    <div
                      key={file.file}
                      className={`group flex cursor-pointer items-center justify-between rounded py-1.5 pr-2.5 transition-colors duration-200 ${
                        isSelected
                          ? "bg-primary/10 border-primary border-l-2 pl-2"
                          : "hover:bg-muted/20 border-l-2 border-transparent pl-2.5"
                      }`}
                      onClick={() => handleFileClick(file.file, file.additions, file.deletions)}
                      title={file.file}
                    >
                      <div className="min-w-0 flex-1 font-mono">
                        <span
                          className={`text-[11px] ${
                            isSelected ? "text-primary/70" : "text-muted-foreground/50"
                          }`}
                        >
                          {displayPath}
                        </span>
                        <span
                          className={`text-[11px] transition-colors duration-200 ${
                            isSelected
                              ? "text-primary font-medium"
                              : "text-foreground/90 group-hover:text-foreground"
                          }`}
                        >
                          {filename}
                        </span>
                      </div>
                      <div className="ml-3 flex min-w-[60px] flex-shrink-0 items-center justify-end gap-2 font-mono tabular-nums">
                        {file.additions > 0 && (
                          <span className="text-success/90 text-[10px] font-semibold">
                            +{file.additions}
                          </span>
                        )}
                        {file.deletions > 0 && (
                          <span className="text-destructive/90 text-[10px] font-semibold">
                            -{file.deletions}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })
                .filter(Boolean)}
            </div>
          ) : selectedWorkspace ? (
            <div className="py-8">
              <Empty className="border-0">
                <EmptyHeader>
                  <EmptyMedia>
                    <Sparkles className="text-muted-foreground/40 h-16 w-16" aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyDescription>No file changes detected</EmptyDescription>
                </EmptyHeader>
              </Empty>
            </div>
          ) : (
            <div className="py-8">
              <Empty className="border-0">
                <EmptyHeader>
                  <EmptyMedia>
                    <FileCode className="text-muted-foreground/40 h-16 w-16" aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyDescription>Select a workspace to view file changes</EmptyDescription>
                </EmptyHeader>
              </Empty>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
