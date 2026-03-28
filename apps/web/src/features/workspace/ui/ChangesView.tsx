/**
 * Changes View — Self-contained diff viewer for the Changes content tab.
 *
 * Shows an infinite-scroll diff viewer (left) + changed files tree (right)
 * with a filter dropdown (All Changes / Uncommitted / Last Turn) and
 * a "Review Changes" button in the header bar.
 *
 * Fetches its own file change data — the parent just provides workspace + context.
 */

import { useRef, useMemo, useCallback, useState } from "react";
import { GitBranch, SlidersHorizontal, ChevronDown, Check, ScanText } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { cn } from "@/shared/lib/utils";
import { useWorkspaceLayout } from "../hooks/useWorkspaceLayout";
import { useFileChanges } from "../api/workspace.queries";
import { AllFilesDiffViewer, type AllFilesDiffViewerRef } from "./AllFilesDiffViewer";
import { DiffFilesTree } from "./DiffFilesTree";
import {
  CHANGES_FILTER_OPTIONS,
  changesFilterLabel,
  type ChangesFilter,
} from "../lib/changesFilter";
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
  const { selectedFilePath } = useWorkspaceLayout(workspace.id);
  const diffViewerRef = useRef<AllFilesDiffViewerRef>(null);
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

  // TODO: Wire up uncommitted/last-turn filters when backend endpoints exist.
  // For now, changesFilter is always "all-changes" (other options are commented out
  // in CHANGES_FILTER_OPTIONS). When adding new filters, fetch the extra data here
  // and use a match() to select the active list.
  const filteredFileChanges = fileChanges;

  // Scroll the diff viewer to the clicked file
  const handleFileClick = useCallback((path: string) => {
    diffViewerRef.current?.scrollToFile(path);
  }, []);

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
        <AllFilesDiffViewer
          ref={diffViewerRef}
          workspaceId={workspace.id}
          fileChanges={filteredFileChanges}
          hideHeader
        />
      ) : (
        <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1">
          <ResizablePanel defaultSize={75} minSize={30}>
            <AllFilesDiffViewer
              ref={diffViewerRef}
              workspaceId={workspace.id}
              fileChanges={filteredFileChanges}
              hideHeader
            />
          </ResizablePanel>

          <ResizableHandle />

          <ResizablePanel defaultSize={25} minSize={15}>
            <DiffFilesTree
              fileChanges={filteredFileChanges}
              selectedFile={selectedFilePath ?? null}
              onFileClick={handleFileClick}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
    </div>
  );
}
