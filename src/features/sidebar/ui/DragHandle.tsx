import { GripVertical } from 'lucide-react';
import { cn } from '@/shared/lib/utils';

interface DragHandleProps {
  attributes?: Record<string, any>;
  listeners?: Record<string, any>;
  setActivatorNodeRef?: (node: HTMLElement | null) => void;
}

/**
 * Drag handle for repository reordering
 * Absolutely positioned to not affect text flow
 * Sits in the padding gutter to the left of content
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
        // Absolute positioning - centered in the padding gutter
        // Positioned at visual midpoint between sidebar edge (0px) and text (20px)
        "absolute -left-2 top-1/2 -translate-y-1/2",
        "flex items-center justify-center",

        // Visibility
        "opacity-0 group-hover/repository-item:opacity-100",
        "transition-opacity duration-200",

        // Visual styling
        "text-sidebar-foreground/50 hover:text-sidebar-foreground/80 transition-colors duration-200",
        "cursor-grab active:cursor-grabbing transition-cursor duration-200",
        "touch-none transition-touch-none duration-200"
      )}
      aria-label="Drag to reorder"
    >
      <GripVertical className="h-4 w-4" />
    </div>
  );
}
