import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/shared/lib/utils";

interface SortableTabProps {
  id: string;
  children: React.ReactNode;
  className?: string;
}

/**
 * Sortable wrapper for chat tabs.
 * Mirrors DraggableRepository pattern but for horizontal tab reordering.
 * The entire tab is the drag activator (no separate handle needed).
 * Transform restricted to X-axis to prevent vertical wobble.
 */
export function SortableTab({ id, children, className }: SortableTabProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    // Snappy spring-like transition for neighbors shifting (ease-out-quart 200ms)
    transition: {
      duration: 200,
      easing: "cubic-bezier(.165, .84, .44, 1)",
    },
  });

  // Use Translate (not Transform) to avoid scaleX/scaleY stretching, lock to X-axis
  const style = {
    transform: CSS.Translate.toString(transform ? { ...transform, y: 0 } : null),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={cn(isDragging && "z-50 opacity-50", className)}
    >
      {children}
    </div>
  );
}
