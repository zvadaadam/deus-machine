import { useEffect } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/shared/lib/utils";
import type { RepositoryItemProps } from "../model/types";
import { RepositoryItem } from "./RepositoryItem";

interface DraggableRepositoryProps extends RepositoryItemProps {
  dragDisabled?: boolean;
}

/**
 * Draggable wrapper for RepositoryItem
 * Entire row is the drag target — click = expand/collapse, drag = reorder
 * PointerSensor distance constraint (in AppSidebar) differentiates the two
 * Auto-collapses on drag start (Linear pattern) for better drag experience
 */
export function DraggableRepository({
  repository,
  isCollapsed,
  onToggleCollapse,
  dragDisabled = false,
  ...props
}: DraggableRepositoryProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: repository.repo_id,
    disabled: dragDisabled,
    // Snappy spring-like transition for neighbors shifting (ease-out-quart 200ms)
    transition: {
      duration: 200,
      easing: "cubic-bezier(.165, .84, .44, 1)",
    },
  });

  // Auto-collapse when drag starts (prevents huge drag preview with many workspaces)
  useEffect(() => {
    if (isDragging && !isCollapsed) {
      onToggleCollapse();
    }
  }, [isDragging, isCollapsed, onToggleCollapse]);

  // Use Translate (not Transform) to avoid scaleX/scaleY stretching during drag
  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={cn(
        isDragging
          ? "z-50 cursor-grabbing [&_*]:cursor-grabbing opacity-70 shadow-lg shadow-black/20 rounded-lg"
          : "cursor-grab [&_*]:cursor-grab",
      )}
    >
      <RepositoryItem
        repository={repository}
        isCollapsed={isCollapsed}
        onToggleCollapse={onToggleCollapse}
        {...props}
      />
    </div>
  );
}
