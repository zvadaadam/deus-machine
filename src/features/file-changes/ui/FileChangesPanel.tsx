/**
 * File Changes Panel
 * Renders the file change tree. Diff viewing is handled externally by MainContent.
 */

import { useMemo, useCallback, useState, useEffect, useRef } from "react";
import { FileChangeTree } from "./FileChangeTree";
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
