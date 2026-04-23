/**
 * ChangesDiffSection — Memoized per-file section for the changes diff view.
 *
 * Uses IntersectionObserver with 600px rootMargin for lazy-loading diff data
 * when the section approaches the viewport.
 *
 * Scroll-spy (active file tracking) is handled by the parent ChangesDiffViewer
 * via a centralized scroll event listener.
 */

import { useState, useRef, useEffect, useCallback, memo } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { fileChangePath } from "../lib/workspace.utils";
import { DiffViewer } from "./DiffViewer";
import { useFileDiff } from "../api/workspace.queries";
import { PierreFileIcon } from "@/features/file-browser/lib/pierreIcons";
import type { FileChange } from "@/shared/types";

interface ChangesDiffSectionProps {
  workspaceId: string;
  fileChange: FileChange;
  isActive: boolean;
  sectionRef: (filePath: string, el: HTMLDivElement | null) => void;
  /** Key counter — when it changes, section resets to expanded state */
  expandStateKey: number;
}

function ChangesDiffSectionInner({
  workspaceId,
  fileChange,
  isActive,
  sectionRef,
  expandStateKey,
}: ChangesDiffSectionProps) {
  const filePath = fileChangePath(fileChange);
  const fileName = filePath.slice(filePath.lastIndexOf("/") + 1) || filePath;
  // Collapse resets to false when expandStateKey changes (parent collapse-all/expand-all)
  const [collapsedState, setCollapsedState] = useState({ value: false, key: expandStateKey });
  const collapsed = collapsedState.key === expandStateKey ? collapsedState.value : false;
  const [isNearVisible, setIsNearVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

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
      {/* Sticky file header. The outer div is the hover-and-click surface:
          `group/row` lets any hover within the 44px row drive the file-icon ↔
          chevron swap below. The inner button stretches (`self-stretch`) so the
          whole row is clickable — no dead zones around the centred content. */}
      <div
        className={cn(
          "group/row sticky top-0 z-[5] flex min-h-[44px] w-full items-center gap-2 px-3 py-1.5 transition-colors duration-200 ease-[cubic-bezier(.165,.84,.44,1)]",
          isActive && "bg-muted",
          !isActive && collapsed && "bg-muted/15 hover:bg-muted/30",
          !isActive && !collapsed && "hover:bg-muted bg-[var(--bg-elevated)]"
        )}
      >
        <button
          type="button"
          onClick={() =>
            setCollapsedState((prev) => ({
              value: prev.key === expandStateKey ? !prev.value : true,
              key: expandStateKey,
            }))
          }
          className="flex min-w-0 flex-1 items-center gap-2 self-stretch text-left"
        >
          {/* Icon slot — Pierre file-type glyph at rest, chevron on row-hover.
              Both live in the same 14×14 box to avoid layout shift. The swap
              is driven by `group/row` on the outer div so it triggers from
              anywhere in the row, not just over the icon. */}
          <div className="relative h-3.5 w-3.5 flex-shrink-0">
            <div className="absolute inset-0 flex items-center justify-center opacity-100 transition-opacity duration-150 ease-out group-hover/row:opacity-0">
              <PierreFileIcon fileName={fileName} size={14} className="text-muted-foreground/70" />
            </div>
            <div className="absolute inset-0 opacity-0 transition-opacity duration-150 ease-out group-hover/row:opacity-100">
              {collapsed ? (
                <ChevronRight className="text-muted-foreground/60 h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="text-muted-foreground/60 h-3.5 w-3.5" />
              )}
            </div>
          </div>

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

export const ChangesDiffSection = memo(ChangesDiffSectionInner, (prev, next) => {
  return (
    fileChangePath(prev.fileChange) === fileChangePath(next.fileChange) &&
    prev.fileChange.additions === next.fileChange.additions &&
    prev.fileChange.deletions === next.fileChange.deletions &&
    prev.isActive === next.isActive &&
    prev.workspaceId === next.workspaceId &&
    prev.expandStateKey === next.expandStateKey
  );
});
