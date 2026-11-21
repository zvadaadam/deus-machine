import { tempo } from "@/shared/lib/tempo";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/shared/lib/utils";

interface SortableSessionTabProps {
  id: string;
  children: React.ReactNode;
  className?: string;
}

/**
 * Sortable wrapper for session tabs.
 * The entire tab is the drag activator, matching the old interaction model.
 */
export function SortableSessionTab({ id, children, className }: SortableSessionTabProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    transition: {
      duration: tempo.moderate.duration * 1000,
      easing: "var(--ease-move)",
    },
  });

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
