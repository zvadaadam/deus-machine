import { GripVertical } from 'lucide-react';
import { cn } from '@/shared/lib/utils';

interface DragHandleProps {
  attributes?: Record<string, any>;
  listeners?: Record<string, any>;
  setActivatorNodeRef?: (node: HTMLElement | null) => void;
}

/**
 * Drag handle for repository reordering
 * Interactive drag activator that doesn't affect text layout
 * Only visible on hover, positioned absolutely
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
        "absolute -left-2 top-1/2 -translate-y-1/2",
        "opacity-0 group-hover:opacity-100 group-data-[state=open]:opacity-100",
        "transition-opacity duration-200 ease-out",
        "text-sidebar-foreground/30 hover:text-sidebar-foreground/60",
        "cursor-grab active:cursor-grabbing",
        "touch-none z-10"
      )}
      aria-label="Drag to reorder"
    >
      <GripVertical className="h-4 w-4" />
    </div>
  );
}
