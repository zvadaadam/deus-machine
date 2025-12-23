/**
 * File Changes Panel
 * Main component for the file changes view
 *
 * Simple design: Click file → see diff
 *
 * Layout:
 * ┌─────────────┬───────────────────────┐
 * │ File Tree   │   Single File Diff    │
 * │  (280px)    │      (flexible)       │
 * │             │                       │
 * │ ▼ src/      │ ┌─────────────────┐   │
 * │   ▼ comp/   │ │ Button.tsx     │   │
 * │     Button  │ │ +5 -2          │   │
 * │     Input   │ │ [diff content] │   │
 * │             │ └─────────────────┘   │
 * └─────────────┴───────────────────────┘
 */

import { useMemo, useCallback, useState, useEffect, useRef } from "react";
import { FileChangeTree } from "./FileChangeTree";
import { DiffViewer } from "@/features/workspace/ui/DiffViewer";
import { Sparkles, FileCode, MousePointerClick } from "lucide-react";
import { Empty, EmptyHeader, EmptyMedia, EmptyDescription } from "@/components/ui/empty";
import { buildFileTree } from "../lib/buildFileTree";
import { useTreeState } from "../hooks/useTreeState";
import type { Workspace } from "@/shared/types";
import type { FileChange } from "@/features/workspace/types";

interface FileChangesPanelProps {
  /** Selected workspace */
  selectedWorkspace: Workspace | null;
  /** File changes from API */
  fileChanges: FileChange[];
  /** Function to fetch diff for a file */
  fetchDiff: (filePath: string) => Promise<{
    diff: string;
    additions?: number;
    deletions?: number;
  }>;
  /** Whether panel is expanded (showing diff view) */
  isExpanded?: boolean;
  /** Callback when a file is selected */
  onFileSelect?: (path: string | null) => void;
}

/**
 * File changes panel with tree sidebar and single file diff view
 */
export function FileChangesPanel({
  selectedWorkspace,
  fileChanges,
  fetchDiff,
  isExpanded = true,
  onFileSelect,
}: FileChangesPanelProps) {
  // Build file tree from flat changes
  const fileTree = useMemo(() => buildFileTree(fileChanges), [fileChanges]);

  // Tree expand/collapse state (persisted per workspace)
  const { expandedPaths, toggle: toggleExpanded } = useTreeState(
    selectedWorkspace?.id ?? null,
    fileTree
  );

  // Currently selected file - track workspace changes via ref
  const prevWorkspaceIdRef = useRef<string | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);

  // Reset selection when workspace changes (via render-time check, not effect)
  const currentWorkspaceId = selectedWorkspace?.id ?? null;
  if (currentWorkspaceId !== prevWorkspaceIdRef.current) {
    prevWorkspaceIdRef.current = currentWorkspaceId;
    if (selectedFilePath !== null) {
      setSelectedFilePath(null);
    }
  }

  // Diff state for selected file
  const [diffState, setDiffState] = useState<{
    diff: string;
    isLoading: boolean;
    error?: string;
  }>({ diff: "", isLoading: false });

  // Get file info for selected file
  const selectedFileInfo = useMemo(() => {
    if (!selectedFilePath) return null;
    return fileChanges.find((fc) => fc.file === selectedFilePath);
  }, [selectedFilePath, fileChanges]);

  // Fetch diff when selected file changes
  useEffect(() => {
    // No file selected - nothing to fetch
    if (!selectedFilePath) {
      return;
    }

    let cancelled = false;

    // Start loading - intentional for async data fetching pattern
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDiffState({ diff: "", isLoading: true });

    fetchDiff(selectedFilePath)
      .then((result) => {
        if (!cancelled) {
          setDiffState({ diff: result.diff, isLoading: false });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setDiffState({
            diff: "",
            isLoading: false,
            error: err?.message || "Failed to load diff",
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedFilePath, fetchDiff]);

  // Handle file selection from tree
  const handleTreeSelect = useCallback(
    (path: string) => {
      setSelectedFilePath(path);
      onFileSelect?.(path);
    },
    [onFileSelect]
  );

  // Derive the display state for diff viewer
  const diffDisplay = useMemo(() => {
    if (!selectedFilePath) {
      return { diff: "", additions: 0, deletions: 0 };
    }
    if (diffState.isLoading) {
      return { diff: "Loading diff...", additions: 0, deletions: 0 };
    }
    if (diffState.error) {
      return { diff: `Error loading diff: ${diffState.error}`, additions: 0, deletions: 0 };
    }
    return {
      diff: diffState.diff,
      additions: selectedFileInfo?.additions ?? 0,
      deletions: selectedFileInfo?.deletions ?? 0,
    };
  }, [selectedFilePath, diffState, selectedFileInfo]);

  // Empty state - no workspace
  if (!selectedWorkspace) {
    return (
      <div className="flex h-full items-center justify-center py-8">
        <Empty className="border-0">
          <EmptyHeader>
            <EmptyMedia>
              <FileCode className="text-muted-foreground/40 h-16 w-16" aria-hidden="true" />
            </EmptyMedia>
            <EmptyDescription>Select a workspace to view file changes</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  // Empty state - no changes
  if (fileChanges.length === 0) {
    return (
      <div className="flex h-full items-center justify-center py-8">
        <Empty className="border-0">
          <EmptyHeader>
            <EmptyMedia>
              <Sparkles className="text-muted-foreground/40 h-16 w-16" aria-hidden="true" />
            </EmptyMedia>
            <EmptyDescription>No file changes detected</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  // Collapsed mode - tree only
  if (!isExpanded) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto">
          <FileChangeTree
            nodes={fileTree}
            expandedPaths={expandedPaths}
            selectedPath={selectedFilePath}
            onToggle={toggleExpanded}
            onSelect={handleTreeSelect}
          />
        </div>
      </div>
    );
  }

  // Expanded mode - tree + single file diff view
  return (
    <div className="flex h-full overflow-hidden">
      {/* File tree sidebar */}
      <div className="border-border/40 w-[280px] flex-shrink-0 overflow-y-auto border-r">
        <FileChangeTree
          nodes={fileTree}
          expandedPaths={expandedPaths}
          selectedPath={selectedFilePath}
          onToggle={toggleExpanded}
          onSelect={handleTreeSelect}
        />
      </div>

      {/* Single file diff view */}
      <div className="flex-1 overflow-hidden">
        {selectedFilePath ? (
          <DiffViewer
            filePath={selectedFilePath}
            diff={diffDisplay.diff}
            additions={diffDisplay.additions}
            deletions={diffDisplay.deletions}
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Empty className="border-0">
              <EmptyHeader>
                <EmptyMedia>
                  <MousePointerClick
                    className="text-muted-foreground/40 h-12 w-12"
                    aria-hidden="true"
                  />
                </EmptyMedia>
                <EmptyDescription>Select a file to view changes</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        )}
      </div>
    </div>
  );
}
