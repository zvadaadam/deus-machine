/**
 * useResizeHandle — Drag-to-resize logic for panel splits.
 *
 * Supports both horizontal (left/right, col-resize) and vertical (top/bottom, row-resize).
 * Tracks mousedown → mousemove → mouseup on a handle element.
 * Returns props to spread onto the handle and an isDragging flag for styling.
 * Double-click resets size to null (auto flex split).
 */

import { useCallback, useEffect, useRef, useState } from "react";

interface UseResizeHandleOptions {
  /** Callback to persist new size in pixels (null = auto) */
  onSizeChange: (size: number | null) => void;
  /** Whether resizing is enabled */
  enabled: boolean;
  /** Resize direction: horizontal = left/right split, vertical = top/bottom split */
  direction?: "horizontal" | "vertical";
  /** Which panel the reported size refers to.
   *  "secondary" (default) = right/bottom panel width/height.
   *  "primary" = left/top panel width/height (useful for sidebar resize). */
  mode?: "secondary" | "primary";
  /** Min size of the secondary (right or bottom) panel in pixels */
  minSecondarySize?: number;
  /** Min size of the primary (left or top) panel in pixels */
  minPrimarySize?: number;
  /** Called when the user drags the primary panel well below minPrimarySize
   *  (past a 50% dead zone). The panel first clamps at minPrimarySize; only
   *  dragging past half that value triggers the collapse callback. */
  onPrimaryCollapse?: () => void;
  /** Whether the primary panel is currently collapsed (for bidirectional drag gestures) */
  isPrimaryCollapsed?: boolean;
  /** Called when the user drags back past the expand threshold while collapsed */
  onPrimaryExpand?: () => void;
}

interface UseResizeHandleReturn {
  handleProps: {
    onMouseDown: (e: React.MouseEvent) => void;
    onDoubleClick: () => void;
  };
  isDragging: boolean;
}

export function useResizeHandle({
  onSizeChange,
  enabled,
  direction = "horizontal",
  mode = "secondary",
  minSecondarySize = 380,
  minPrimarySize = 200,
  onPrimaryCollapse,
  isPrimaryCollapsed = false,
  onPrimaryExpand,
}: UseResizeHandleOptions): UseResizeHandleReturn {
  const isDraggingRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  const isPrimaryCollapsedRef = useRef(isPrimaryCollapsed);

  useEffect(() => {
    isPrimaryCollapsedRef.current = isPrimaryCollapsed;
  }, [isPrimaryCollapsed]);

  useEffect(() => {
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!enabled) return;
      e.preventDefault();

      isDraggingRef.current = true;
      setIsDragging(true);

      const handle = e.currentTarget as HTMLElement;
      const container = handle.parentElement;
      if (!container) {
        isDraggingRef.current = false;
        setIsDragging(false);
        return;
      }

      const onMouseMove = (moveEvent: MouseEvent) => {
        if (!isDraggingRef.current) return;

        const rect = container.getBoundingClientRect();
        const totalSize = direction === "horizontal" ? rect.width : rect.height;

        // Raw primary size (before clamping) for snap-to-collapse detection
        const rawPrimaryOffset =
          direction === "horizontal" ? moveEvent.clientX - rect.left : moveEvent.clientY - rect.top;

        // Bidirectional snap points:
        // - Collapse when dragging well below minPrimarySize.
        // - Re-expand when dragging back beyond minPrimarySize.
        // This creates a dead zone / hysteresis that prevents jitter.
        const collapseThreshold = minPrimarySize * 0.5;
        const expandThreshold = minPrimarySize;
        const currentlyCollapsed = isPrimaryCollapsedRef.current;

        if (!currentlyCollapsed && onPrimaryCollapse && rawPrimaryOffset < collapseThreshold) {
          isPrimaryCollapsedRef.current = true;
          onPrimaryCollapse();
          return;
        }

        if (currentlyCollapsed && onPrimaryExpand && rawPrimaryOffset > expandThreshold) {
          isPrimaryCollapsedRef.current = false;
          onPrimaryExpand();
        }

        if (isPrimaryCollapsedRef.current) {
          return;
        }

        if (mode === "primary") {
          // Primary mode: report left/top panel size
          let newPrimarySize = rawPrimaryOffset;
          const maxPrimarySize = Math.max(0, totalSize - minSecondarySize);
          newPrimarySize = Math.max(newPrimarySize, Math.min(minPrimarySize, maxPrimarySize));
          newPrimarySize = Math.min(newPrimarySize, maxPrimarySize);
          onSizeChange(Math.round(newPrimarySize));
        } else {
          // Secondary mode (default): report right/bottom panel size
          const newSecondaryRaw = totalSize - rawPrimaryOffset;
          const maxSecondarySize = Math.max(0, totalSize - minPrimarySize);
          let newSecondarySize = Math.max(
            newSecondaryRaw,
            Math.min(minSecondarySize, maxSecondarySize)
          );
          newSecondarySize = Math.min(newSecondarySize, maxSecondarySize);
          onSizeChange(Math.round(newSecondarySize));
        }
      };

      const cleanup = () => {
        isDraggingRef.current = false;
        setIsDragging(false);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      const onMouseUp = () => {
        cleanup();
        cleanupRef.current = null;
      };

      document.body.style.cursor = direction === "horizontal" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      cleanupRef.current = cleanup;
    },
    [
      enabled,
      direction,
      mode,
      minSecondarySize,
      minPrimarySize,
      onSizeChange,
      onPrimaryCollapse,
      onPrimaryExpand,
    ]
  );

  const handleDoubleClick = useCallback(() => {
    if (!enabled) return;
    onSizeChange(null);
  }, [enabled, onSizeChange]);

  return {
    handleProps: {
      onMouseDown: handleMouseDown,
      onDoubleClick: handleDoubleClick,
    },
    isDragging,
  };
}
