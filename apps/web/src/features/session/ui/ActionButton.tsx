/**
 * ActionButton - Refined button for user message actions
 *
 * Compact button with icon and optional label text.
 * Designed to sit below user messages, visible on hover.
 */

import { type LucideIcon } from "lucide-react";
import { cn } from "@/shared/lib/utils";

interface ActionButtonProps {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  active?: boolean;
  showLabel?: boolean;
  className?: string;
}

export function ActionButton({
  icon: Icon,
  label,
  onClick,
  active = false,
  showLabel = true,
  className,
}: ActionButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "hover:bg-muted/40 text-muted-foreground hover:text-foreground ease flex h-6 items-center gap-1.5 rounded-md px-2 text-xs transition-colors duration-200",
        active && "text-success hover:bg-success/10",
        className
      )}
      aria-label={label}
      aria-pressed={active}
    >
      <Icon className="h-3 w-3" />
      {showLabel && <span>{label}</span>}
    </button>
  );
}
