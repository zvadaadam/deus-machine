/**
 * Code Panel Content — Changes/Files sub-tab view inside the content panel.
 *
 * Two modes driven by the "Changes" / "Files" sub-tabs:
 *   Changes: AllFilesDiffViewer (infinite scroll) | 1px separator | DiffFilesTree
 *   Files:   FileViewer (single file preview) | 1px separator | FileBrowserPanel (220px)
 *
 * Both modes share the same split structure: content on the left, file tree on the right.
 * The diff and file tree are always visible when there are changes — no collapsing.
 * When there are no changes, a clean empty state is shown.
 *
 * The Changes view includes a filter dropdown (All Changes / Uncommitted / Last Turn)
 * that controls which subset of file changes is visible in both the diff viewer and tree.
 */

import { useRef, useMemo, useCallback, useState } from "react";
import { GitBranch, FileText, SlidersHorizontal, ChevronDown, Check } from "lucide-react";
import { FileBrowserPanel, FileViewer } from "@/features/file-browser";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { match } from "ts-pattern";
import { cn } from "@/shared/lib/utils";
import { AllFilesDiffViewer, type AllFilesDiffViewerRef } from "./AllFilesDiffViewer";
import { DiffFilesTree } from "./DiffFilesTree";
import {
  CHANGES_FILTER_OPTIONS,
  changesFilterLabel,
  type ChangesFilter,
} from "../lib/changesFilter";
import type { Workspace } from "@/shared/types";
import type { FileChange } from "@/features/workspace/types";
import type { WorkspaceGitInfo } from "../api/workspace.service";

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
  /** Git info for fetching diffs */
  workspaceGitInfo: WorkspaceGitInfo;
  /** Callback to insert a code review prompt into the chat input */
  onReview?: () => void;
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
  filterMode = "changes",
  onFilterModeChange,
  workspaceGitInfo,
  onReview,
}: CodePanelContentProps) {
  const diffViewerRef = useRef<AllFilesDiffViewerRef>(null);
  const [changesFilter, setChangesFilter] = useState<ChangesFilter>("all-changes");

  // Apply the changes filter to get the active file list.
  // We check for the array itself (not .length) to distinguish "loaded but empty" ([])
  // from "not available" (undefined). An empty array means the filter is active but has no
  // matches — the user should see an empty state, not a fallback to all changes.
  const filteredFileChanges = useMemo(
    () =>
      match(changesFilter)
        .with("uncommitted", () => uncommittedFiles ?? fileChanges)
        .with("last-turn", () => lastTurnFiles ?? fileChanges)
        .with("all-changes", () => fileChanges)
        .exhaustive(),
    [changesFilter, fileChanges, uncommittedFiles, lastTurnFiles]
  );

  // Handle file click in Changes view — scroll the infinite scroll diff viewer
  // to the clicked file. AllFilesDiffViewer's scrollToFile also updates the
  // store's selectedFile, so DiffFilesTree highlighting stays in sync.
  const handleChangesFileClick = useCallback((path: string) => {
    diffViewerRef.current?.scrollToFile(path);
  }, []);

  // Build absolute file path for FileViewer from the relative selectedFilePath.
  // Only meaningful in Files view, but computed unconditionally (cheap string op).
  const absoluteFilePath = useMemo(() => {
    if (!selectedFilePath) return null;
    const base = workspace.workspace_path.replace(/\/+$/, "");
    const rel = selectedFilePath.replace(/^\/+/, "");
    return `${base}/${rel}`;
  }, [selectedFilePath, workspace.workspace_path]);

  const activeFilterLabel = changesFilterLabel(changesFilter);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Sub tabs — Changes | Files + filter dropdown (right) */}
      <div className="border-border-subtle flex h-10 flex-shrink-0 items-center justify-between border-b px-4">
        <div className="flex items-center">
          <button
            type="button"
            onClick={() => onFilterModeChange?.("changes")}
            className={cn(
              "h-7 rounded-[5px] px-3 text-sm transition-colors duration-200 ease",
              filterMode === "changes"
                ? "bg-bg-elevated text-text-primary font-medium"
                : "text-text-muted hover:text-text-secondary"
            )}
          >
            Changes
          </button>
          <button
            type="button"
            onClick={() => onFilterModeChange?.("all")}
            className={cn(
              "h-7 rounded-[5px] px-3 text-sm transition-colors duration-200 ease",
              filterMode === "all"
                ? "bg-bg-elevated text-text-primary font-medium"
                : "text-text-muted hover:text-text-secondary"
            )}
          >
            Files
          </button>
        </div>

        {/* Filter dropdown — visible in Changes mode only */}
        {filterMode === "changes" && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="text-text-muted hover:text-text-secondary flex items-center gap-1 rounded-md px-1.5 py-1 text-sm transition-colors duration-200 ease">
                <SlidersHorizontal className="h-[11px] w-[11px]" />
                <span>{activeFilterLabel}</span>
                <ChevronDown className="h-[10px] w-[10px]" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[140px]">
              {CHANGES_FILTER_OPTIONS.map(([value, label]) => (
                <DropdownMenuItem
                  key={value}
                  onClick={() => setChangesFilter(value)}
                  className="gap-2 text-xs"
                >
                  <Check
                    className={cn(
                      "h-3 w-3",
                      changesFilter === value ? "opacity-100" : "opacity-0"
                    )}
                  />
                  {label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Content area */}
      {filterMode === "changes" ? (
        filteredFileChanges.length === 0 ? (
          /* Empty state — no file changes */
          <div className="flex flex-1 flex-col items-center justify-center gap-3">
            <div className="bg-bg-muted/30 flex h-10 w-10 items-center justify-center rounded-xl">
              <GitBranch className="text-text-muted/50 h-5 w-5" aria-hidden="true" />
            </div>
            <p className="text-text-muted/60 text-xs">No file changes yet</p>
            <p className="text-text-muted/40 max-w-[200px] text-center text-[11px]">
              Changes will appear here as the agent modifies files
            </p>
          </div>
        ) : (
          /* Changes view — infinite scroll diffs + resizable changed files tree */
          <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1">
            {/* Diff pane — infinite scroll of all stacked diffs */}
            <ResizablePanel defaultSize={75} minSize={30}>
              <AllFilesDiffViewer
                ref={diffViewerRef}
                workspaceId={workspace.id}
                fileChanges={filteredFileChanges}
                workspaceGitInfo={workspaceGitInfo}
                hideHeader
              />
            </ResizablePanel>

            <ResizableHandle />

            {/* Changed files tree — resizable */}
            <ResizablePanel defaultSize={25} minSize={15}>
              <DiffFilesTree
                fileChanges={filteredFileChanges}
                selectedFile={selectedFilePath ?? null}
                onFileClick={handleChangesFileClick}
                onReview={onReview}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
        )
      ) : (
        /* Files view — file viewer + resizable file tree */
        <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1">
          {/* File viewer — fills remaining space */}
          <ResizablePanel defaultSize={75} minSize={30}>
            {absoluteFilePath ? (
              <FileViewer filePath={absoluteFilePath} />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3">
                <div className="bg-bg-muted/30 flex h-10 w-10 items-center justify-center rounded-xl">
                  <FileText className="text-text-muted/50 h-5 w-5" aria-hidden="true" />
                </div>
                <p className="text-text-muted/60 text-xs">Select a file to preview</p>
              </div>
            )}
          </ResizablePanel>

          <ResizableHandle />

          {/* File tree — resizable */}
          <ResizablePanel defaultSize={25} minSize={15}>
            <FileBrowserPanel
              selectedWorkspace={workspace}
              fileChanges={fileChanges}
              uncommittedFiles={uncommittedFiles}
              lastTurnFiles={lastTurnFiles}
              fileChangesTruncated={fileChangesTruncated}
              fileChangesTotalCount={fileChangesTotalCount}
              selectedFilePath={selectedFilePath}
              onFileClick={onFileClick}
              filterMode="all"
              onFilterModeChange={onFilterModeChange}
              hideTabToggle
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
    </div>
  );
}
