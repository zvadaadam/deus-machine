import { GripVertical } from 'lucide-react';
import { cn } from '@/shared/lib/utils';

/**
 * Visual drag indicator for repository reordering
 * Non-interactive - entire row is draggable
 * Only visible on hover
 */
export function DragHandle() {
  return (
    <div
      className={cn(
        "flex-shrink-0 -ml-1 mr-2",
        "opacity-0 group-hover:opacity-100",
        "transition-opacity duration-200 ease-out",
        "text-sidebar-foreground/30 pointer-events-none"
      )}
      aria-hidden="true"
    >
      <GripVertical className="h-4 w-4" />
    </div>
  );
}
