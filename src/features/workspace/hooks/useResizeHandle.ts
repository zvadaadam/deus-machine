/**
 * useResizeHandle — Drag-to-resize logic for the chat/right-panel split.
 *
 * Tracks mousedown → mousemove → mouseup on a vertical handle element.
 * Returns props to spread onto the handle and an isDragging flag for styling.
 * Double-click resets width to null (auto flex split).
 */

import { useCallback, useRef, useState } from "react";

interface UseResizeHandleOptions {
  /** Callback to persist new width (null = auto) */
  onWidthChange: (width: number | null) => void;
  /** Whether resizing is enabled (only when panel is in wide mode) */
  enabled: boolean;
  /** Min width of the right panel area in pixels */
  minRightWidth?: number;
  /** Min width of the left (chat) area in pixels */
  minLeftWidth?: number;
}

interface UseResizeHandleReturn {
  handleProps: {
    onMouseDown: (e: React.MouseEvent) => void;
    onDoubleClick: () => void;
  };
  isDragging: boolean;
}

export function useResizeHandle({
  onWidthChange,
  enabled,
  minRightWidth = 450,
  minLeftWidth = 350,
}: UseResizeHandleOptions): UseResizeHandleReturn {
  const isDraggingRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!enabled) return;
      e.preventDefault();

      isDraggingRef.current = true;
      setIsDragging(true);

      // The flex row containing chat + handle + right panel
      const handle = e.currentTarget as HTMLElement;
      const container = handle.parentElement;
      if (!container) return;

      const onMouseMove = (moveEvent: MouseEvent) => {
        if (!isDraggingRef.current) return;

        const containerRect = container.getBoundingClientRect();
        const containerWidth = containerRect.width;

        // Mouse position relative to container left edge
        const mouseX = moveEvent.clientX - containerRect.left;
        // Right panel width = total container width - mouse position
        let newRightWidth = containerWidth - mouseX;

        // Clamp to constraints
        newRightWidth = Math.max(newRightWidth, minRightWidth);
        newRightWidth = Math.min(newRightWidth, containerWidth - minLeftWidth);

        onWidthChange(Math.round(newRightWidth));
      };

      const onMouseUp = () => {
        isDraggingRef.current = false;
        setIsDragging(false);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [enabled, minRightWidth, minLeftWidth, onWidthChange]
  );

  const handleDoubleClick = useCallback(() => {
    if (!enabled) return;
    onWidthChange(null);
  }, [enabled, onWidthChange]);

  return {
    handleProps: {
      onMouseDown: handleMouseDown,
      onDoubleClick: handleDoubleClick,
    },
    isDragging,
  };
}
