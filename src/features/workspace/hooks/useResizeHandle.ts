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
}: UseResizeHandleOptions): UseResizeHandleReturn {
  const isDraggingRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);

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

        if (mode === "primary") {
          // Primary mode: report left/top panel size
          const mouseOffset =
            direction === "horizontal"
              ? moveEvent.clientX - rect.left
              : moveEvent.clientY - rect.top;
          let newPrimarySize = mouseOffset;
          newPrimarySize = Math.max(newPrimarySize, minPrimarySize);
          newPrimarySize = Math.min(newPrimarySize, totalSize - minSecondarySize);
          onSizeChange(Math.round(newPrimarySize));
        } else {
          // Secondary mode (default): report right/bottom panel size
          let newSecondarySize: number;
          if (direction === "horizontal") {
            const mouseX = moveEvent.clientX - rect.left;
            newSecondarySize = rect.width - mouseX;
          } else {
            const mouseY = moveEvent.clientY - rect.top;
            newSecondarySize = rect.height - mouseY;
          }
          newSecondarySize = Math.max(newSecondarySize, minSecondarySize);
          newSecondarySize = Math.min(newSecondarySize, totalSize - minPrimarySize);
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
    [enabled, direction, mode, minSecondarySize, minPrimarySize, onSizeChange]
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
