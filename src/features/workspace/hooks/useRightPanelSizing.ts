/**
 * Right Panel Sizing Hook
 *
 * Encapsulates all right panel sizing logic:
 * - Per-tab target sizes (normal 30%, browser 60%)
 * - Category boundary detection (normal <-> browser)
 * - Pixel <-> percent conversion for react-resizable-panels
 * - Stored width restoration on mount/workspace switch
 * - Programmatic expand+resize with persistence guard
 *
 * Two size categories:
 * - Normal (code, config, terminal, design) — default 30%, stored via rightPanelWidth
 * - Browser (when not detached) — default 60%, stored via rightPanelWidthBrowser
 *
 * Key API: resizeToTab(tab) handles expand-from-collapsed (expand() + resize())
 * and category boundary transitions. Callers never need to touch the panel ref directly.
 */

import { useCallback, useRef, useLayoutEffect } from "react";
import type { ImperativePanelHandle } from "react-resizable-panels";
import { useWorkspaceLayout } from "./useWorkspaceLayout";
import type { RightSideTab } from "../store/workspaceLayoutStore";

const NORMAL_DEFAULT_PCT = 30;
const BROWSER_DEFAULT_PCT = 60;
// Sizes below this are collapse artifacts — a panel being dragged to collapse
// fires onResize with progressively smaller values. Persisting those would
// corrupt the stored width, causing expand-from-collapsed to target ~2% instead
// of 30%/60%. Also guards getTargetPercent against already-corrupted values.
const MIN_PERSIST_PCT = NORMAL_DEFAULT_PCT * 0.5; // 15%

/** Whether a tab belongs to the "wide" size category (browser, simulator) */
function isBrowserCategory(tab: RightSideTab, detached: boolean): boolean {
  if (tab === "simulator") return true;
  return tab === "browser" && !detached;
}

interface UseRightPanelSizingOptions {
  workspaceId: string | null;
  panelGroupContainerRef: React.RefObject<HTMLDivElement | null>;
  rightPanelRef: React.RefObject<ImperativePanelHandle | null>;
  isBrowserDetached: boolean;
  middlePanelActive: boolean;
}

interface UseRightPanelSizingResult {
  /** Target percent for a given tab (from stored px or default 30%/60%) */
  getTargetPercent: (tab: RightSideTab) => number;
  /** Whether switching from → to crosses a size category boundary */
  isCategoryBoundary: (from: RightSideTab, to: RightSideTab) => boolean;
  /** Expand (if collapsed) and resize to the target tab's stored/default width.
   *  Skips persistence — the target width is already stored or is the default. */
  resizeToTab: (tab: RightSideTab) => void;
  /** Persist current panel size to store (wire to onResize) */
  handleResize: (sizePercent: number) => void;
  /** Guard ref — reset on workspace switch. Prevents restore loop during drag. */
  hasRestoredWidthRef: React.MutableRefObject<boolean>;
}

export function useRightPanelSizing({
  workspaceId,
  panelGroupContainerRef,
  rightPanelRef,
  isBrowserDetached,
  middlePanelActive,
}: UseRightPanelSizingOptions): UseRightPanelSizingResult {
  const {
    rightPanelWidth,
    rightPanelWidthNormal,
    rightPanelWidthBrowser,
    setRightPanelWidth,
  } = useWorkspaceLayout(workspaceId);

  const hasRestoredWidthRef = useRef(false);
  // Guard: skip persistence during programmatic resize (expand+resize combo).
  // The target width is already stored — persisting intermediate onResize values
  // from expand() would corrupt the store with the wrong tab's width.
  const skipPersistRef = useRef(false);

  // Compute target percent from stored px or defaults.
  // Reads container width synchronously for accurate px→% conversion.
  const getTargetPercent = useCallback(
    (tab: RightSideTab): number => {
      const isBrowser = isBrowserCategory(tab, isBrowserDetached);
      const defaultPct = isBrowser ? BROWSER_DEFAULT_PCT : NORMAL_DEFAULT_PCT;

      const container = panelGroupContainerRef.current;
      if (!container) return defaultPct;
      const total = container.getBoundingClientRect().width;
      if (total <= 0) return defaultPct;

      const storedPx = isBrowser ? rightPanelWidthBrowser : rightPanelWidthNormal;
      if (storedPx !== null) {
        const pct = (storedPx / total) * 100;
        // Guard: if stored width converts to less than the minimum sane percentage,
        // it's a collapse artifact (e.g., 36px persisted before skipPersist guard).
        if (pct >= MIN_PERSIST_PCT) return pct;
      }
      return defaultPct;
    },
    [panelGroupContainerRef, isBrowserDetached, rightPanelWidthNormal, rightPanelWidthBrowser]
  );

  // Detect when switching tabs crosses a size category boundary (normal <-> browser).
  const isCategoryBoundary = useCallback(
    (from: RightSideTab, to: RightSideTab): boolean => {
      return isBrowserCategory(from, isBrowserDetached) !== isBrowserCategory(to, isBrowserDetached);
    },
    [isBrowserDetached]
  );

  // Expand from collapsed (or resize if already expanded) to the target tab's width.
  //
  // Two code paths because collapsed panels need special handling:
  // - Collapsed: expand() first to exit collapsed mode, then resize() after
  //   React commits the expansion (rAF). Transitions suppressed so both steps
  //   appear as one instant jump from collapsed strip to target size.
  // - Expanded: resize() directly — smooth CSS transition to new size.
  const resizeToTab = useCallback(
    (tab: RightSideTab) => {
      const panel = rightPanelRef.current;
      if (!panel) return;

      skipPersistRef.current = true;

      if (panel.isCollapsed()) {
        // Suppress flex-grow transition so expand→resize is visually instant.
        const container = panelGroupContainerRef.current;
        container?.setAttribute("data-suppress-transition", "");
        panel.expand();
        // resize() after React commits the expand state (rAF bridges the gap).
        // Without this, resize() may see the panel as still collapsed internally.
        requestAnimationFrame(() => {
          panel.resize(getTargetPercent(tab));
          requestAnimationFrame(() => {
            container?.removeAttribute("data-suppress-transition");
            skipPersistRef.current = false;
          });
        });
      } else {
        // Already expanded — instant resize (no CSS transition).
        // Content switches in the same frame (React re-render from setRightSideTab),
        // so animating the size would show the NEW content at the OLD width for the
        // duration of the transition. Suppress transition → single-frame update.
        const container = panelGroupContainerRef.current;
        container?.setAttribute("data-suppress-transition", "");
        panel.resize(getTargetPercent(tab));
        requestAnimationFrame(() => {
          container?.removeAttribute("data-suppress-transition");
          skipPersistRef.current = false;
        });
      }
    },
    [rightPanelRef, panelGroupContainerRef, getTargetPercent]
  );

  // Persist panel size to store on user drag.
  // Converts percentage from react-resizable-panels to pixels for Zustand.
  // Skipped during programmatic resize (resizeToTab) to prevent corruption.
  const handleResize = useCallback(
    (sizePercent: number) => {
      if (skipPersistRef.current) return;
      // Don't persist collapse-artifact sizes. When a user drags the panel to
      // collapse, onResize fires with progressively smaller values before
      // onCollapse fires. Storing these would corrupt the "last good width".
      if (sizePercent < MIN_PERSIST_PCT) return;
      const container = panelGroupContainerRef.current;
      if (!container) return;
      const total = container.getBoundingClientRect().width;
      if (total > 0) {
        setRightPanelWidth(Math.round((sizePercent / 100) * total));
      }
    },
    [panelGroupContainerRef, setRightPanelWidth]
  );

  // Restore stored panel width once after mount / workspace switch.
  // useLayoutEffect runs before paint so the user sees no flash.
  // The hasRestoredWidthRef guard prevents re-firing during drag
  // (onResize → setRightPanelWidth → effect → resize() feedback loop).
  useLayoutEffect(() => {
    if (hasRestoredWidthRef.current) return;
    if (rightPanelWidth === null || middlePanelActive) return;
    const container = panelGroupContainerRef.current;
    if (!container || !rightPanelRef.current) return;
    const total = container.getBoundingClientRect().width;
    if (total <= 0) return;
    const restoredPct = (rightPanelWidth / total) * 100;
    // Skip if stored width is a collapse artifact — let defaultSize apply instead.
    if (restoredPct < MIN_PERSIST_PCT) return;
    {
      // Suppress CSS transition during restoration to prevent visible animation
      // when switching workspaces. The data attribute overrides the flex-grow
      // transition rule in global.css.
      container.setAttribute("data-suppress-transition", "");
      skipPersistRef.current = true;
      rightPanelRef.current.resize(restoredPct);
      hasRestoredWidthRef.current = true;
      // Re-enable after the library applies the size and the browser paints.
      // Double rAF bridges useLayoutEffect → library commit → paint.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          container.removeAttribute("data-suppress-transition");
          skipPersistRef.current = false;
        });
      });
    }
  }, [rightPanelWidth, middlePanelActive, panelGroupContainerRef, rightPanelRef]);

  return {
    getTargetPercent,
    isCategoryBoundary,
    resizeToTab,
    handleResize,
    hasRestoredWidthRef,
  };
}
