/**
 * DiffTabContent — Self-contained diff viewer for the middle panel.
 *
 * Fetches diff data via useFileDiff (TanStack Query with 10s cache)
 * and renders the existing DiffViewer component. Each tab instance
 * owns its own query, so multiple diff tabs work independently.
 *
 * Supports optional prev/next file navigation when viewing multiple
 * changed files — renders a thin navigation bar above the diff.
 */

import { ChevronUp, ChevronDown } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { DiffViewer } from "./DiffViewer";
import { useFileDiff } from "../api/workspace.queries";
import type { WorkspaceGitInfo } from "../api/workspace.service";

interface DiffTabContentProps {
  workspaceId: string;
  filePath: string;
  workspaceGitInfo: WorkspaceGitInfo;
  onClose?: () => void;
  /** Navigate to previous changed file */
  onPrevFile?: () => void;
  /** Navigate to next changed file */
  onNextFile?: () => void;
  /** Zero-based index of the current file in the changed files list */
  fileIndex?: number;
  /** Total number of changed files */
  fileCount?: number;
}

export function DiffTabContent({
  workspaceId,
  filePath,
  workspaceGitInfo,
  onClose,
  onPrevFile,
  onNextFile,
  fileIndex,
  fileCount,
}: DiffTabContentProps) {
  const { data, isLoading, error } = useFileDiff(workspaceId, filePath, workspaceGitInfo);

  const showNavigation = fileCount != null && fileCount > 1 && fileIndex != null;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* File navigation bar — only shown when browsing multiple changed files */}
      {showNavigation && (
        <div className="border-border/40 bg-muted/20 flex h-7 flex-shrink-0 items-center justify-between border-b px-2">
          <span className="text-muted-foreground/70 text-2xs tabular-nums">
            {fileIndex + 1} / {fileCount}
          </span>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={onPrevFile}
              disabled={!onPrevFile}
              className={cn(
                "flex h-5 w-5 items-center justify-center rounded transition-colors",
                onPrevFile
                  ? "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                  : "text-muted-foreground/30 cursor-not-allowed"
              )}
              title="Previous file"
            >
              <ChevronUp className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={onNextFile}
              disabled={!onNextFile}
              className={cn(
                "flex h-5 w-5 items-center justify-center rounded transition-colors",
                onNextFile
                  ? "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                  : "text-muted-foreground/30 cursor-not-allowed"
              )}
              title="Next file"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      <DiffViewer
        filePath={filePath}
        diff={data?.diff ?? ""}
        oldContent={data?.oldContent ?? null}
        newContent={data?.newContent ?? null}
        isLoading={isLoading}
        error={error?.message}
        onClose={onClose}
      />
    </div>
  );
}
