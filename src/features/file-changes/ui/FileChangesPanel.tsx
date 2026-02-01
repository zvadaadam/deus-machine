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
import { Sparkles, FileCode } from "lucide-react";
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
    oldContent?: string | null;
    newContent?: string | null;
  }>;
  /** Whether panel is expanded (showing diff view) */
  isExpanded?: boolean;
  /** Callback when a file is selected */
  onFileSelect?: (path: string | null) => void;
  /** Callback when diff viewer requests close */
  onDiffClose?: () => void;
  /** Optional header slot rendered above the file tree */
  headerSlot?: React.ReactNode;
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
  onDiffClose,
  headerSlot,
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

  const currentWorkspaceId = selectedWorkspace?.id ?? null;
  useEffect(() => {
    if (currentWorkspaceId !== prevWorkspaceIdRef.current) {
      prevWorkspaceIdRef.current = currentWorkspaceId;
      // Reset selection when workspace changes - intentional pattern for clearing related state
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedFilePath(null);
    }
  }, [currentWorkspaceId]);

  // Diff state for selected file
  const [diffState, setDiffState] = useState<{
    diff: string;
    isLoading: boolean;
    error?: string;
    oldContent?: string | null;
    newContent?: string | null;
  }>({ diff: "", isLoading: false });

  // Fetch diff when selected file changes
  useEffect(() => {
    if (!selectedFilePath) {
      return;
    }

    let cancelled = false;

    // Start loading - intentional for async data fetching pattern
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDiffState({ diff: "", isLoading: true, oldContent: null, newContent: null });

    fetchDiff(selectedFilePath)
      .then((result) => {
        if (!cancelled) {
          setDiffState({
            diff: result.diff,
            isLoading: false,
            oldContent: result.oldContent ?? null,
            newContent: result.newContent ?? null,
          });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setDiffState({
            diff: "",
            isLoading: false,
            error: err?.message || "Failed to load diff",
            oldContent: null,
            newContent: null,
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

  // Auto-select first file when expanded with changes but no selection
  useEffect(() => {
    if (isExpanded && fileChanges.length > 0 && !selectedFilePath) {
      const firstChange = fileChanges[0];
      const firstFile = firstChange.file || firstChange.file_path || "";
      if (firstFile) {
        // Auto-select first file on expansion - intentional pattern for initializing state
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSelectedFilePath(firstFile);
        onFileSelect?.(firstFile);
      }
    }
  }, [isExpanded, fileChanges, selectedFilePath, onFileSelect]);

  // Empty state - no workspace
  if (!selectedWorkspace) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        {headerSlot}
        <div className="flex flex-1 items-center justify-center py-8">
          <Empty className="border-0">
            <EmptyHeader>
              <EmptyMedia>
                <FileCode className="text-muted-foreground/40 h-16 w-16" aria-hidden="true" />
              </EmptyMedia>
              <EmptyDescription>Select a workspace to view file changes</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      </div>
    );
  }

  // Empty state - no changes
  if (fileChanges.length === 0) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        {headerSlot}
        <div className="flex flex-1 items-center justify-center py-8">
          <Empty className="border-0">
            <EmptyHeader>
              <EmptyMedia>
                <Sparkles className="text-muted-foreground/40 h-16 w-16" aria-hidden="true" />
              </EmptyMedia>
              <EmptyDescription>No file changes detected</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      </div>
    );
  }

  // Collapsed mode - tree only
  if (!isExpanded) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        {headerSlot}
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
      <div className="border-border/40 flex w-[280px] flex-shrink-0 flex-col overflow-hidden border-r">
        {headerSlot}
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

      {/* Single file diff view */}
      <div className="flex-1 overflow-hidden">
        {selectedFilePath && (
          <DiffViewer
            filePath={selectedFilePath}
            diff={diffState.diff}
            isLoading={diffState.isLoading}
            error={diffState.error}
            oldContent={diffState.oldContent ?? null}
            newContent={diffState.newContent ?? null}
            onClose={() => {
              setSelectedFilePath(null);
              onFileSelect?.(null);
              onDiffClose?.();
            }}
          />
        )}
      </div>
    </div>
  );
}
