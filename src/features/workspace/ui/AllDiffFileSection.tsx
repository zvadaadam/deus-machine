/**
 * AllDiffFileSection — Memoized per-file section for the all-diffs view.
 *
 * Uses IntersectionObserver with 600px rootMargin for lazy-loading diff data
 * when the section approaches the viewport.
 *
 * Scroll-spy (active file tracking) is handled by the parent AllFilesDiffViewer
 * via a centralized scroll event listener — simpler and more reliable than
 * distributed observers across memoized children.
 *
 * CSS `content-visibility: auto` (via `.diff-section-contained`) lets the browser
 * skip layout/paint for offscreen sections — matches Codex app pattern.
 */

import { useState, useRef, useEffect, useCallback, memo } from "react";
import type { RefObject } from "react";
import { ChevronDown, ChevronRight, FileCode } from "lucide-react";
import { DiffViewer } from "./DiffViewer";
import { useFileDiff } from "../api/workspace.queries";
import type { WorkspaceGitInfo } from "../api/workspace.service";
import type { FileChange } from "@/shared/types";

interface AllDiffFileSectionProps {
  workspaceId: string;
  fileChange: FileChange;
  workspaceGitInfo: WorkspaceGitInfo;
  isActive: boolean;
  sectionRef: (filePath: string, el: HTMLDivElement | null) => void;
  /** Key counter — when it changes, section resets to expanded state */
  expandStateKey: number;
  /** Open file in text editor (file preview mode) */
  onOpenFile?: (filePath: string) => void;
  /** Scroll container ref — kept for potential future use */
  scrollRoot?: RefObject<HTMLDivElement | null>;
}

function AllDiffFileSectionInner({
  workspaceId,
  fileChange,
  workspaceGitInfo,
  isActive,
  sectionRef,
  expandStateKey,
  onOpenFile,
}: AllDiffFileSectionProps) {
  const filePath = fileChange.file || fileChange.file_path || "";
  const [collapsed, setCollapsed] = useState(false);
  const [isNearVisible, setIsNearVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Reset collapsed state when expandStateKey changes (collapse-all/expand-all)
  useEffect(() => {
    setCollapsed(false);
  }, [expandStateKey]);

  // Register ref for scroll-to-file and parent scroll-spy
  const refCallback = useCallback(
    (el: HTMLDivElement | null) => {
      containerRef.current = el;
      sectionRef(filePath, el);
    },
    [filePath, sectionRef]
  );

  // IntersectionObserver: lazy loading (600px rootMargin)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsNearVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "600px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Fetch diff only when near-visible
  const { data, isLoading, error } = useFileDiff(
    isNearVisible ? workspaceId : null,
    isNearVisible ? filePath : null,
    workspaceGitInfo
  );

  return (
    <div
      ref={refCallback}
      data-diff-path={filePath}
      className="diff-section-contained"
    >
      {/* Sticky file header */}
      <button
        type="button"
        onClick={() => setCollapsed((prev) => !prev)}
        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors duration-200 ease-[ease] ${
          isActive
            ? "bg-muted/60"
            : collapsed
              ? "bg-muted/15 hover:bg-muted/30"
              : "bg-[var(--bg-elevated)] hover:bg-muted/50"
        }`}
        style={{
          position: "sticky",
          top: 0,
          zIndex: 5,
        }}
      >
        {collapsed ? (
          <ChevronRight className="text-muted-foreground/60 h-3.5 w-3.5 flex-shrink-0" />
        ) : (
          <ChevronDown className="text-muted-foreground/60 h-3.5 w-3.5 flex-shrink-0" />
        )}

        <span className={`min-w-0 flex-1 truncate text-sm font-medium${
          collapsed ? " text-muted-foreground/70" : ""
        }`}>{filePath}</span>

        {/* +N / -N stats */}
        <span className="flex flex-shrink-0 items-center gap-1.5 text-sm tabular-nums">
          {fileChange.additions > 0 && (
            <span className="text-success/80">+{fileChange.additions}</span>
          )}
          {fileChange.deletions > 0 && (
            <span className="text-destructive/80">-{fileChange.deletions}</span>
          )}
        </span>

        {/* Open in editor */}
        {onOpenFile && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onOpenFile(filePath);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.stopPropagation();
                e.preventDefault();
                onOpenFile(filePath);
              }
            }}
            className="text-muted-foreground/50 hover:text-foreground hover:bg-muted/50 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded transition-colors duration-200 ease"
            title="Open in editor"
          >
            <FileCode className="h-3 w-3" />
          </span>
        )}
      </button>

      {/* Diff content — hidden when collapsed */}
      {!collapsed && (
        <DiffViewer
          filePath={filePath}
          diff={data?.diff ?? ""}
          oldContent={data?.oldContent ?? null}
          newContent={data?.newContent ?? null}
          isLoading={isNearVisible ? isLoading : true}
          error={error?.message}
          embedded
        />
      )}
    </div>
  );
}

export const AllDiffFileSection = memo(AllDiffFileSectionInner, (prev, next) => {
  const prevPath = prev.fileChange.file || prev.fileChange.file_path || "";
  const nextPath = next.fileChange.file || next.fileChange.file_path || "";
  return (
    prevPath === nextPath &&
    prev.fileChange.additions === next.fileChange.additions &&
    prev.fileChange.deletions === next.fileChange.deletions &&
    prev.isActive === next.isActive &&
    prev.workspaceId === next.workspaceId &&
    prev.expandStateKey === next.expandStateKey
  );
});
