import { GripVertical } from 'lucide-react';
import { cn } from '@/shared/lib/utils';

interface DragHandleProps {
  attributes?: Record<string, any>;
  listeners?: Record<string, any>;
  setActivatorNodeRef?: (node: HTMLElement | null) => void;
}

/**
 * Drag handle for repository reordering
 * Simple flex child with conditional visibility
 */
export function DragHandle({
  attributes,
  listeners,
  setActivatorNodeRef,
}: DragHandleProps) {
  return (
    <div
      ref={setActivatorNodeRef}
      {...attributes}
      {...listeners}
      className={cn(
        "flex-shrink-0 -ml-[16px]",
        "opacity-0 group-hover:opacity-100 group-data-[state=open]:opacity-100",
        "transition-opacity duration-200",
        "text-sidebar-foreground/30 hover:text-sidebar-foreground/60",
        "cursor-grab active:cursor-grabbing",
        "touch-none"
      )}
      aria-label="Drag to reorder"
    >
      <GripVertical className="h-4 w-4" />
    </div>
  );
}
