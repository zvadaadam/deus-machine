import { useEffect } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/shared/lib/utils";
import { tempo } from "@/shared/lib/tempo";
import type { RepositoryItemProps } from "../model/types";
import { RepositoryItem } from "./RepositoryItem";

interface DraggableRepositoryProps extends RepositoryItemProps {
  dragDisabled?: boolean;
}

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

  // The header starts the drag. The whole project moves with it.
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        isDragging &&
          "z-50 cursor-grabbing rounded-lg opacity-70 shadow-lg shadow-black/20 [&_*]:cursor-grabbing"
      )}
    >
      <RepositoryItem
        dragHandle={{ ref: setActivatorNodeRef, ...attributes, ...listeners }}
        repository={repository}
        isCollapsed={isCollapsed}
        onToggleCollapse={onToggleCollapse}
        {...props}
      />
    </div>
  );
}
