/**
 * SortableWorkspaceTabShell — horizontal-locked @dnd-kit wrapper for workspace tabs.
 *
 * Separated from Framer Motion components so @dnd-kit owns drag transforms
 * cleanly with horizontal axis locking (y: 0) and Deus's `tempo.moderate`
 * move easing.
 */

import type { ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { tempo } from "@/shared/lib/tempo";
import { cn } from "@/shared/lib/utils";

interface SortableWorkspaceTabShellProps {
  id: string;
  children: (state: { isDragging: boolean }) => ReactNode;
  className?: string;
}

export function SortableWorkspaceTabShell({
  id,
  children,
  className,
}: SortableWorkspaceTabShellProps) {
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

  // Omit dnd-kit's default role="button" / tabIndex=0 so the inner <button role="tab">
  // owns keyboard focus and ARIA semantics without nested interactive roles.
  const { role: _role, tabIndex: _tabIndex, ...dragAttributes } = attributes;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...dragAttributes}
      {...listeners}
      className={cn("relative shrink-0", isDragging && "z-30 opacity-85", className)}
    >
      {children({ isDragging })}
    </div>
  );
}
