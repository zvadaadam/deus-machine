/**
 * Code Panel Content — Unified file tree with changes overlay.
 * Replaced the old two-tab (Changes / All files) approach with a single
 * FileBrowserPanel that has an inline filter toggle.
 */

import { FileBrowserPanel } from "@/features/file-browser";
import type { Workspace } from "@/shared/types";
import type { FileChange } from "@/features/workspace/types";

interface CodePanelContentProps {
  workspace: Workspace;
  fileChanges: FileChange[];
  /** Uncommitted-only file changes (HEAD → workdir) */
  uncommittedFiles?: FileChange[];
  /** Last-turn file changes (checkpoint → workdir) */
  lastTurnFiles?: FileChange[];
  selectedFilePath?: string | null;
  onFileClick: (path: string) => void;
}

export function CodePanelContent({
  workspace,
  fileChanges,
  uncommittedFiles,
  lastTurnFiles,
  selectedFilePath,
  onFileClick,
}: CodePanelContentProps) {
  return (
    <FileBrowserPanel
      selectedWorkspace={workspace}
      fileChanges={fileChanges}
      uncommittedFiles={uncommittedFiles}
      lastTurnFiles={lastTurnFiles}
      selectedFilePath={selectedFilePath}
      onFileClick={onFileClick}
    />
  );
}
