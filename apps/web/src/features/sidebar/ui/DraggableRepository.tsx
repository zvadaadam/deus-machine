import { useEffect } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS, useCombinedRefs } from "@dnd-kit/utilities";
import { cn } from "@/shared/lib/utils";
import { tempo } from "@/shared/lib/tempo";
import type { RepositoryItemProps } from "../model/types";
import { RepositoryItem } from "./RepositoryItem";

interface DraggableRepositoryProps extends RepositoryItemProps {
  dragDisabled?: boolean;
}

/**
 * Draggable wrapper for RepositoryItem
 * Entire row is the drag target — click = expand/collapse, drag = reorder
 * PointerSensor distance constraint (in AppSidebar) differentiates the two
 * Auto-collapses on drag start for better drag experience
 */
export function DraggableRepository({
  repository,
  isCollapsed,
  onToggleCollapse,
  dragDisabled = false,
  ...props
}: DraggableRepositoryProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: repository.repo_id,
    disabled: dragDisabled,
    transition: {
      duration: tempo.moderate.duration * 1000,
      easing: "var(--ease-move)",
    },
  });
  // Only the focused project starts a keyboard drag. Its nested controls keep Enter and Space.
  const dragRef = useCombinedRefs(setNodeRef, setActivatorNodeRef);

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
      ref={dragRef}
      style={style}
      {...attributes}
      {...listeners}
      className={cn(
        isDragging &&
          "z-50 cursor-grabbing rounded-lg opacity-70 shadow-lg shadow-black/20 [&_*]:cursor-grabbing"
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
