import { ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  EmptyStateContainer,
  EmptyStateTitle,
  EmptyStateDescription,
} from "@/components/content/empty-state";

interface EmptyStateProps {
  icon: ReactNode;
  title?: string;
  description?: string;
  action?: ReactNode;
  animate?: boolean;
  className?: string;
}

/**
 * Shared EmptyState component using official shadcn empty-state pattern
 * Styled with Tailwind CSS following CLAUDE.md animation guidelines
 * Wraps shadcn's EmptyStateContainer, EmptyStateTitle, and EmptyStateDescription
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  animate = false,
  className,
}: EmptyStateProps) {
  return (
    <EmptyStateContainer
      className={cn(
        "p-12 gap-4",
        animate && "animate-in fade-in-50 slide-in-from-bottom-4 duration-300",
        className
      )}
    >
      {/* Icon with subtle styling */}
      <div className="text-5xl opacity-60 transition-opacity duration-200 ease-out hover:opacity-80">
        {icon}
      </div>

      {/* Title */}
      {title && (
        <EmptyStateTitle className="text-xl font-semibold">
          {title}
        </EmptyStateTitle>
      )}

      {/* Description */}
      {description && (
        <EmptyStateDescription className="max-w-md">
          {description}
        </EmptyStateDescription>
      )}

      {/* Optional action button */}
      {action && <div className="mt-2">{action}</div>}
    </EmptyStateContainer>
  );
}
