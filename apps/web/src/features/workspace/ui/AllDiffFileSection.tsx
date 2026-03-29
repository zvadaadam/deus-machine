/**
 * AllDiffFileSection — Memoized per-file section for the all-diffs view.
 *
 * Uses IntersectionObserver with 600px rootMargin for lazy-loading diff data
 * when the section approaches the viewport.
 *
 * Scroll-spy (active file tracking) is handled by the parent AllFilesDiffViewer
 * via a centralized scroll event listener.
 */

import { useState, useRef, useEffect, useCallback, memo } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { DiffViewer } from "./DiffViewer";
import { useFileDiff } from "../api/workspace.queries";
import type { FileChange } from "@/shared/types";

interface AllDiffFileSectionProps {
  workspaceId: string;
  fileChange: FileChange;
  isActive: boolean;
  sectionRef: (filePath: string, el: HTMLDivElement | null) => void;
  /** Key counter — when it changes, section resets to expanded state */
  expandStateKey: number;
}

function AllDiffFileSectionInner({
  workspaceId,
  fileChange,
  isActive,
  sectionRef,
  expandStateKey,
}: AllDiffFileSectionProps) {
  const filePath = fileChange.file || fileChange.file_path || "";
  const [collapsedState, setCollapsedState] = useState({
    value: false,
    expandStateKey,
  });
  const [isNearVisible, setIsNearVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Collapse state resets to expanded whenever expandStateKey changes,
  // without requiring a state update from an effect.
  const collapsed = collapsedState.expandStateKey === expandStateKey ? collapsedState.value : false;

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
    isNearVisible ? filePath : null
  );

  return (
    <div ref={refCallback} data-diff-path={filePath} className="overflow-clip">
      {/* Sticky file header — two sibling buttons to avoid nesting interactive elements */}
      <div
        className={`sticky top-0 z-[5] flex min-h-[44px] w-full items-center gap-2 px-3 py-1.5 transition-colors duration-200 ease-[cubic-bezier(.165,.84,.44,1)] ${
          isActive
            ? "bg-muted"
            : collapsed
              ? "bg-muted/15 hover:bg-muted/30"
              : "hover:bg-muted bg-[var(--bg-elevated)]"
        }`}
      >
        {/* Collapse toggle — covers chevron, path, and stats */}
        <button
          type="button"
          onClick={() =>
            setCollapsedState((prev) => ({
              value: prev.expandStateKey === expandStateKey ? !prev.value : true,
              expandStateKey,
            }))
          }
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          {collapsed ? (
            <ChevronRight className="text-muted-foreground/60 h-3.5 w-3.5 flex-shrink-0" />
          ) : (
            <ChevronDown className="text-muted-foreground/60 h-3.5 w-3.5 flex-shrink-0" />
          )}

          <span
            className={cn(
              "min-w-0 flex-1 truncate text-sm font-medium",
              collapsed && "text-muted-foreground/70"
            )}
          >
            {filePath}
          </span>

          {/* +N / -N stats */}
          <span className="flex flex-shrink-0 items-center gap-1.5 text-sm tabular-nums">
            {fileChange.additions > 0 && (
              <span className="text-success/80">+{fileChange.additions}</span>
            )}
            {fileChange.deletions > 0 && (
              <span className="text-destructive/80">-{fileChange.deletions}</span>
            )}
          </span>
        </button>
      </div>

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
          workspaceId={workspaceId}
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
