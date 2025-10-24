import { GripVertical } from "lucide-react";
import { cn } from "@/shared/lib/utils";

interface DragHandleProps {
  listeners?: any;
  attributes?: any;
  setActivatorNodeRef?: (element: HTMLElement | null) => void;
}

/**
 * Drag handle component for repository reordering
 * Appears on hover (desktop) or always visible (touch)
 * Follows Linear/Notion pattern for low-frequency drag operations
 */
export function DragHandle({
  listeners,
  attributes,
  setActivatorNodeRef,
}: DragHandleProps) {
  return (
    <div
      ref={setActivatorNodeRef}
      {...listeners}
      {...attributes}
      role="button"
      className={cn(
        // Layout
        "flex items-center justify-center flex-shrink-0",
        "h-5 w-5 -ml-1 mr-1",

        // Color
        "text-muted-foreground hover:text-foreground",

        // Visibility (progressive disclosure)
        "opacity-0 group-hover/repo:opacity-100 focus-visible:opacity-100",

        // Cursor
        "cursor-grab active:cursor-grabbing",

        // Transitions
        "transition-all duration-200",
        "motion-reduce:transition-none",

        // Focus styles
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",

        // Prevent text selection during drag
        "select-none"
      )}
      aria-label="Drag to reorder repository"
      tabIndex={0}
      // Prevent triggering CollapsibleTrigger on click, but allow pointer events for drag
      onClick={(e) => e.stopPropagation()}
    >
      <GripVertical className="h-4 w-4" />
    </div>
  );
}
