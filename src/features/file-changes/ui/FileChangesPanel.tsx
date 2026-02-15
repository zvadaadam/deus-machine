/**
 * File Changes Panel
 * Renders the file change tree. Diff viewing is handled externally by MainContent.
 */

import { useMemo, useCallback, useState, useEffect, useRef } from "react";
import { FileChangeTree } from "./FileChangeTree";
import { GitBranch, FileCode } from "lucide-react";
import { buildFileTree } from "../lib/buildFileTree";
import { useTreeState } from "../hooks/useTreeState";
import type { Workspace } from "@/shared/types";
import type { FileChange } from "@/features/workspace/types";

interface FileChangesPanelProps {
  /** Selected workspace */
  selectedWorkspace: Workspace | null;
  /** File changes from API */
  fileChanges: FileChange[];
  /** Optional controlled selection (persisted by parent/workspace store) */
  selectedFilePath?: string | null;
  /** Callback when a file is selected */
  onFileSelect?: (path: string | null) => void;
  /** Optional header slot rendered above the file tree */
  headerSlot?: React.ReactNode;
}

/**
 * File changes panel - renders file tree only. Diff viewing is handled by MainContent.
 */
export function FileChangesPanel({
  selectedWorkspace,
  fileChanges,
  selectedFilePath,
  onFileSelect,
  headerSlot,
}: FileChangesPanelProps) {
  // Build file tree from flat changes
  const fileTree = useMemo(() => buildFileTree(fileChanges), [fileChanges]);

  // Tree expand/collapse state (persisted per workspace)
  const { expandedPaths, toggle: toggleExpanded } = useTreeState(
    selectedWorkspace?.id ?? null,
    fileTree
  );

  // Local fallback selection (used when parent does not control selection)
  const prevWorkspaceIdRef = useRef<string | null>(null);
  const [localSelectedFilePath, setLocalSelectedFilePath] = useState<string | null>(null);

  const currentWorkspaceId = selectedWorkspace?.id ?? null;
  useEffect(() => {
    if (currentWorkspaceId !== prevWorkspaceIdRef.current) {
      prevWorkspaceIdRef.current = currentWorkspaceId;
      // Reset local fallback selection when workspace changes.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLocalSelectedFilePath(null);
    }
  }, [currentWorkspaceId]);

  const effectiveSelectedFilePath = selectedFilePath ?? localSelectedFilePath;

  // Handle file selection from tree
  const handleTreeSelect = useCallback(
    (path: string) => {
      if (selectedFilePath === undefined) {
        setLocalSelectedFilePath(path);
      }
      onFileSelect?.(path);
    },
    [selectedFilePath, onFileSelect]
  );

  // Empty state - no workspace
  if (!selectedWorkspace) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        {headerSlot}
        <div
          className="flex flex-1 flex-col items-center justify-center gap-3"
          style={{ animation: "fadeInUp 0.4s cubic-bezier(.215, .61, .355, 1)" }}
        >
          <div className="bg-muted/30 flex h-10 w-10 items-center justify-center rounded-xl">
            <FileCode className="text-muted-foreground/50 h-5 w-5" aria-hidden="true" />
          </div>
          <p className="text-muted-foreground/60 text-xs">Select a workspace to view changes</p>
        </div>
      </div>
    );
  }

  // Empty state - no changes
  if (fileChanges.length === 0) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        {headerSlot}
        <div
          className="flex flex-1 flex-col items-center justify-center gap-3"
          style={{ animation: "fadeInUp 0.4s cubic-bezier(.215, .61, .355, 1)" }}
        >
          <div className="bg-muted/30 flex h-10 w-10 items-center justify-center rounded-xl">
            <GitBranch className="text-muted-foreground/50 h-5 w-5" aria-hidden="true" />
          </div>
          <p className="text-muted-foreground/60 text-xs">No file changes detected</p>
        </div>
      </div>
    );
  }

  // Tree view only — diff is rendered in MainContent's middle panel
  return (
    <div className="flex h-full flex-col overflow-hidden">
      {headerSlot}
      <div className="flex-1 overflow-y-auto">
        <FileChangeTree
          nodes={fileTree}
          expandedPaths={expandedPaths}
          selectedPath={effectiveSelectedFilePath}
          onToggle={toggleExpanded}
          onSelect={handleTreeSelect}
        />
      </div>
    </div>
  );
}
