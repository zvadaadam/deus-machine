/**
 * ChangesDiffViewer — Scrollable container for all changed files' diffs.
 *
 * Renders each changed file as a ChangesDiffSection with lazy loading.
 * Exposes `scrollToFile(path)` via ref for bidirectional sync with the file tree.
 * Tracks which file is currently visible and reports it via `onActiveFileChange`.
 *
 * Scroll-spy: centralized scroll listener finds the topmost visible section
 * and syncs active file state to the sidebar tree.
 *
 * Performance: IntersectionObserver lazy loading per section, React.memo,
 * rAF-throttled scroll spy.
 */

import { forwardRef, useImperativeHandle, useRef, useCallback, useState, useEffect } from "react";
import { ChevronsUpDown } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { ChangesDiffSection } from "./ChangesDiffSection";
import { fileChangePath } from "../lib/workspace.utils";
import { workspaceLayoutActions } from "../store";
import type { FileChange } from "@/shared/types";

export interface ChangesDiffViewerRef {
  scrollToFile: (path: string) => void;
}

interface ChangesDiffViewerProps {
  workspaceId: string;
  fileChanges: FileChange[];
  /** Hide the header bar (file count, collapse/expand). Used when
   *  the viewer is embedded inside ChangesView which has its own chrome. */
  hideHeader?: boolean;
  onActiveFileChange?: (filePath: string | null) => void;
  /** File to scroll to on mount (one-shot) */
  initialScrollTarget?: string;
  /** Additional class names for the root container */
  className?: string;
}

export const ChangesDiffViewer = forwardRef<ChangesDiffViewerRef, ChangesDiffViewerProps>(
  function ChangesDiffViewer(
    { workspaceId, fileChanges, hideHeader, onActiveFileChange, initialScrollTarget, className },
    ref
  ) {
    const sectionRefsMap = useRef(new Map<string, HTMLDivElement>());
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const [activeFile, setActiveFile] = useState<string | null>(null);
    // Key counter for collapse-all/expand-all — incrementing remounts all sections expanded
    const [expandStateKey, setExpandStateKey] = useState(0);

    // Ref-based stable wrappers for props that change identity on refetch.
    const workspaceIdRef = useRef(workspaceId);
    const fileChangesRef = useRef(fileChanges);
    const onActiveFileChangeRef = useRef(onActiveFileChange);

    useEffect(() => {
      workspaceIdRef.current = workspaceId;
      fileChangesRef.current = fileChanges;
      onActiveFileChangeRef.current = onActiveFileChange;
    });

    // Clear ref maps on unmount to prevent stale entries
    useEffect(() => {
      return () => {
        sectionRefsMap.current.clear();
      };
    }, []);

    // Resolve a file path to its DOM element — ref map first, DOM query fallback.
    const resolveSection = useCallback((path: string): HTMLElement | null => {
      const el = sectionRefsMap.current.get(path);
      if (el) return el;
      return (
        scrollContainerRef.current?.querySelector(`[data-diff-path="${CSS.escape(path)}"]`) ?? null
      );
    }, []);

    // Scroll-spy: find topmost visible section and sync to store.
    const activeFileRef = useRef<{ workspaceId: string; path: string | null }>({
      workspaceId,
      path: null,
    });

    // Shared helper — updates all active-file state + store in one place.
    const setActiveFilePath = useCallback((path: string | null) => {
      const currentWorkspaceId = workspaceIdRef.current;
      const prev = activeFileRef.current;
      if (prev.workspaceId === currentWorkspaceId && prev.path === path) return;
      activeFileRef.current = { workspaceId: currentWorkspaceId, path };
      setActiveFile(path);
      onActiveFileChangeRef.current?.(path);
      workspaceLayoutActions.setSelectedFilePath(currentWorkspaceId, path);
    }, []);

    useEffect(() => {
      const container = scrollContainerRef.current;
      if (!container) return;

      let rafId = 0;

      const updateActiveFile = () => {
        rafId = 0;
        const changes = fileChangesRef.current;
        if (changes.length === 0) return;

        const containerRect = container.getBoundingClientRect();
        // Threshold: a section is "active" if its top is within the top third
        // of the scroll container. This feels natural — the file you're reading
        // is the one near the top, not the one partially entering at the bottom.
        const threshold = containerRect.top + containerRect.height * 0.33;

        let best: string | null = null;

        for (const fc of changes) {
          const path = fileChangePath(fc);
          const el = sectionRefsMap.current.get(path);
          if (!el) continue;

          const rect = el.getBoundingClientRect();
          // Section is visible if its bottom is below container top AND its top
          // is above the threshold line.
          if (rect.bottom > containerRect.top && rect.top <= threshold) {
            best = path;
          }
        }

        // Fallback: if nothing passes the threshold (scrolled to very bottom),
        // pick the last section that's at least partially visible.
        if (best === null) {
          for (let i = changes.length - 1; i >= 0; i--) {
            const path = fileChangePath(changes[i]);
            const el = sectionRefsMap.current.get(path);
            if (!el) continue;
            const rect = el.getBoundingClientRect();
            if (rect.top < containerRect.bottom && rect.bottom > containerRect.top) {
              best = path;
              break;
            }
          }
        }

        setActiveFilePath(best);
      };

      const onScroll = () => {
        if (rafId === 0) {
          rafId = requestAnimationFrame(updateActiveFile);
        }
      };

      container.addEventListener("scroll", onScroll, { passive: true });

      // Fire once on mount to set the initial active file
      requestAnimationFrame(updateActiveFile);

      return () => {
        container.removeEventListener("scroll", onScroll);
        if (rafId !== 0) cancelAnimationFrame(rafId);
      };
    }, []); // Stable — reads fileChanges via ref; section registration uses callback refs

    // One-shot scroll to initial target after sections mount and register refs
    useEffect(() => {
      if (!initialScrollTarget) return;
      const raf = requestAnimationFrame(() => {
        const target = resolveSection(initialScrollTarget);
        if (!target) return;
        setActiveFilePath(initialScrollTarget);
        target.scrollIntoView({
          behavior: "auto",
          block: "start",
        });
      });
      return () => cancelAnimationFrame(raf);
    }, [initialScrollTarget, workspaceId, resolveSection, setActiveFilePath]);

    // Expose scrollToFile to parent — immediately updates active file
    // so the tree highlight changes without waiting for the scroll event.
    useImperativeHandle(
      ref,
      () => ({
        scrollToFile(path: string) {
          setActiveFilePath(path);
          const el = resolveSection(path);
          if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "start" });
          }
        },
      }),
      [workspaceId, resolveSection]
    );

    // Section ref callback — populates the ref map
    const sectionRefCallback = useCallback((filePath: string, el: HTMLDivElement | null) => {
      if (el) {
        sectionRefsMap.current.set(filePath, el);
      } else {
        sectionRefsMap.current.delete(filePath);
      }
    }, []);

    const handleCollapseExpandAll = useCallback(() => {
      setExpandStateKey((prev) => prev + 1);
    }, []);

    return (
      <div className={cn("flex h-full flex-col overflow-hidden", className)}>
        {/* Header bar — hidden when embedded in ChangesView */}
        {!hideHeader && (
          <div className="bg-muted/20 border-border/40 flex h-8 flex-shrink-0 items-center justify-between border-b px-3">
            <span className="text-muted-foreground/70 text-xs tabular-nums">
              {fileChanges.length} {fileChanges.length === 1 ? "file" : "files"} changed
            </span>
            <button
              type="button"
              onClick={handleCollapseExpandAll}
              className="text-muted-foreground hover:text-foreground hover:bg-muted/50 ease flex h-5 w-5 items-center justify-center rounded-md transition-colors duration-200"
              title="Reset expand/collapse"
            >
              <ChevronsUpDown className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Scrollable file sections */}
        <div
          ref={scrollContainerRef}
          className="divide-border/40 flex flex-1 flex-col divide-y overflow-y-auto pb-3"
        >
          {fileChanges.map((fc) => {
            const path = fileChangePath(fc);
            return (
              <ChangesDiffSection
                key={path}
                workspaceId={workspaceId}
                fileChange={fc}
                isActive={activeFile === path}
                sectionRef={sectionRefCallback}
                expandStateKey={expandStateKey}
              />
            );
          })}
        </div>
      </div>
    );
  }
);
