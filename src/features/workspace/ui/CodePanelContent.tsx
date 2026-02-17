/**
 * Code Panel Content — Unified file tree with changes overlay.
 * Replaced the old two-tab (Changes / All files) approach with a single
 * FileBrowserPanel that has an inline filter toggle.
 */

import { FileBrowserPanel } from "@/features/file-browser";
import type { Workspace } from "@/shared/types";
import type { FileChange } from "@/features/workspace/types";

type FilterMode = "all" | "changes";

interface CodePanelContentProps {
  workspace: Workspace;
  fileChanges: FileChange[];
  /** Uncommitted-only file changes (HEAD → workdir) */
  uncommittedFiles?: FileChange[];
  /** Last-turn file changes (checkpoint → workdir) */
  lastTurnFiles?: FileChange[];
  /** True if the file changes list was truncated (too many files) */
  fileChangesTruncated?: boolean;
  /** Total number of changed files (before truncation) */
  fileChangesTotalCount?: number;
  selectedFilePath?: string | null;
  onFileClick: (path: string) => void;
  /** Active filter tab (Changes / All files) — persisted in store */
  filterMode?: FilterMode;
  /** Called when user switches filter tab */
  onFilterModeChange?: (mode: FilterMode) => void;
}

export function CodePanelContent({
  workspace,
  fileChanges,
  uncommittedFiles,
  lastTurnFiles,
  fileChangesTruncated,
  fileChangesTotalCount,
  selectedFilePath,
  onFileClick,
  filterMode,
  onFilterModeChange,
}: CodePanelContentProps) {
  return (
    <FileBrowserPanel
      selectedWorkspace={workspace}
      fileChanges={fileChanges}
      uncommittedFiles={uncommittedFiles}
      lastTurnFiles={lastTurnFiles}
      fileChangesTruncated={fileChangesTruncated}
      fileChangesTotalCount={fileChangesTotalCount}
      selectedFilePath={selectedFilePath}
      onFileClick={onFileClick}
      filterMode={filterMode}
      onFilterModeChange={onFilterModeChange}
    />
  );
}
