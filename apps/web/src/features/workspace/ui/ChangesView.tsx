/**
 * Changes View — Self-contained diff viewer for the Changes content tab.
 *
 * Two layout modes (persisted per workspace):
 * - Pinned (default): resizable two-panel layout with permanent file tree sidebar.
 * - Minimap: full-width diff viewer + thin colored strip; hover reveals file tree.
 *
 * Also supports compact mode (mobile) — diff viewer only.
 */

import { useRef, useMemo, useCallback, useState, useEffect } from "react";
import {
  GitBranch,
  SlidersHorizontal,
  ChevronDown,
  Check,
  ScanText,
  PanelRight,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { cn } from "@/shared/lib/utils";
import { useWorkspaceLayout } from "../hooks/useWorkspaceLayout";
import { useWorkspaceLayoutStore, workspaceLayoutActions } from "../store/workspaceLayoutStore";
import { useFileChanges } from "../api/workspace.queries";
import { ChangesDiffViewer, type ChangesDiffViewerRef } from "./ChangesDiffViewer";
import { ChangesFilesPanel } from "./ChangesFilesPanel";
import { ChangesMinimap } from "./ChangesMinimap";
import {
  CHANGES_FILTER_OPTIONS,
  changesFilterLabel,
  type ChangesFilter,
} from "../lib/changesFilter";
import { fileChangePath } from "../lib/workspace.utils";
import type { Workspace } from "@/shared/types";

interface ChangesViewProps {
  workspace: Workspace;
  /** Whether file watcher is active — disables polling in useFileChanges */
  isWatched?: boolean;
  /** Callback to insert a code review prompt into the chat input */
  onReview?: () => void;
  /** Single-column layout without file tree side panel (used on mobile) */
  compact?: boolean;
}

export function ChangesView({ workspace, isWatched = false, onReview, compact }: ChangesViewProps) {
  const { selectedFilePath, fileTreePinned, setFileTreePinned } = useWorkspaceLayout(workspace.id);
  const pendingFileNavigation = useWorkspaceLayoutStore(
    (state) => state.layouts[workspace.id]?.pendingFileNavigation ?? null
  );
  const navigationRequest =
    pendingFileNavigation?.target === "changes" ? pendingFileNavigation : null;
  const diffViewerRef = useRef<ChangesDiffViewerRef>(null);
  const [changesFilter, setChangesFilter] = useState<ChangesFilter>("all-changes");

  const isReady = workspace.state === "ready";

  // Fetch file change data
  const { data: fileChangesData } = useFileChanges(
    isReady ? workspace.id : null,
    workspace.session_status,
    isWatched,
    workspace.state
  );
  const fileChanges = useMemo(() => fileChangesData?.files ?? [], [fileChangesData]);

  const filteredFileChanges = fileChanges; // TODO: apply filter when backend supports it

  useEffect(() => {
    if (!navigationRequest) return;
    const targetExists = filteredFileChanges.some(
      (fileChange) => fileChangePath(fileChange) === navigationRequest.path
    );
    if (!targetExists) return;
    diffViewerRef.current?.scrollToFile(navigationRequest.path);
    workspaceLayoutActions.setPendingFileNavigation(workspace.id, null);
  }, [filteredFileChanges, navigationRequest, workspace.id]);

  // Scroll the diff viewer to the clicked file
  const handleFileClick = useCallback((path: string) => {
    diffViewerRef.current?.scrollToFile(path);
  }, []);

  const handlePin = useCallback(() => setFileTreePinned(true), [setFileTreePinned]);
  const handleUnpin = useCallback(() => setFileTreePinned(false), [setFileTreePinned]);

  const activeFilterLabel = changesFilterLabel(changesFilter);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header — filter dropdown (left) + review button (right) */}
      <div className="border-border-subtle flex h-10 flex-shrink-0 items-center justify-between border-b px-4">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="text-text-muted hover:text-text-secondary ease flex items-center gap-1 rounded-lg px-1.5 py-1 text-sm transition-colors duration-200"
            >
              <SlidersHorizontal className="h-[11px] w-[11px]" />
              <span>{activeFilterLabel}</span>
              <ChevronDown className="h-[10px] w-[10px]" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[140px]">
            {CHANGES_FILTER_OPTIONS.map(([value, label]) => (
              <DropdownMenuItem
                key={value}
                onClick={() => setChangesFilter(value)}
                className="gap-2 text-xs"
              >
                <Check
                  className={cn("h-3 w-3", changesFilter === value ? "opacity-100" : "opacity-0")}
                />
                {label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {onReview && filteredFileChanges.length > 0 && (
          <button
            type="button"
            onClick={onReview}
            className="bg-primary/8 hover:bg-primary/14 text-primary ease flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors duration-200"
          >
            <ScanText className="h-3 w-3" />
            <span>Review Changes</span>
            <span className="text-primary/60 ml-0.5 text-[10px] font-normal">
              {filteredFileChanges.length}
            </span>
          </button>
        )}
      </div>

      {/* Content area */}
      {filteredFileChanges.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <div className="bg-bg-muted/30 flex h-10 w-10 items-center justify-center rounded-xl">
            <GitBranch className="text-text-muted/50 h-5 w-5" aria-hidden="true" />
          </div>
          <p className="text-text-muted/60 text-xs">No file changes yet</p>
          <p className="text-text-muted/40 max-w-[200px] text-center text-[11px]">
            Changes will appear here as the agent modifies files
          </p>
        </div>
      ) : compact ? (
        <ChangesDiffViewer
          ref={diffViewerRef}
          workspaceId={workspace.id}
          fileChanges={filteredFileChanges}
          hideHeader
        />
      ) : fileTreePinned ? (
        /* Pinned mode — resizable two-panel layout with permanent file tree */
        <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1">
          <ResizablePanel defaultSize={75} minSize={30}>
            <ChangesDiffViewer
              ref={diffViewerRef}
              workspaceId={workspace.id}
              fileChanges={filteredFileChanges}
              hideHeader
            />
          </ResizablePanel>

          <ResizableHandle />

          <ResizablePanel
            defaultSize={25}
            minSize={15}
            collapsible
            collapsedSize={0}
            onCollapse={handleUnpin}
          >
            <div className="flex h-full flex-col overflow-hidden">
              {/* Pinned panel header with collapse button */}
              <div className="border-border/30 flex h-8 flex-shrink-0 items-center justify-between border-b px-3">
                <div className="flex items-center gap-1.5">
                  <span className="text-text-muted text-xs">Files</span>
                  <span className="text-text-muted/60 text-[10px] tabular-nums">
                    {filteredFileChanges.length}
                  </span>
                </div>
                <div className="flex items-center">
                  <button
                    type="button"
                    onClick={handleUnpin}
                    aria-label="Collapse file tree to minimap"
                    className="text-text-muted hover:text-text-secondary hover:bg-muted/50 ease flex h-5 w-5 items-center justify-center rounded-md transition-colors duration-150"
                    title="Collapse to minimap"
                  >
                    <PanelRight className="h-3 w-3" />
                  </button>
                </div>
              </div>
              <ChangesFilesPanel
                fileChanges={filteredFileChanges}
                selectedFile={selectedFilePath ?? null}
                onFileClick={handleFileClick}
              />
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        /* Minimap mode — full-width diff viewer + thin strip on right */
        <div className="flex min-h-0 flex-1">
          <ChangesDiffViewer
            ref={diffViewerRef}
            workspaceId={workspace.id}
            fileChanges={filteredFileChanges}
            hideHeader
            className="min-w-0 flex-1"
          />
          <ChangesMinimap
            fileChanges={filteredFileChanges}
            selectedFile={selectedFilePath ?? null}
            onFileClick={handleFileClick}
            onPin={handlePin}
          />
        </div>
      )}
    </div>
  );
}
