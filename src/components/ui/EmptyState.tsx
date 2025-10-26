import { ReactNode } from "react";
import { cn } from "@/shared/lib/utils";
import {
  EmptyStateContainer,
  EmptyStateTitle,
  EmptyStateDescription,
} from "@/shared/components";

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
        "flex flex-col items-center justify-center text-center p-4 py-16 gap-4",
        animate && "animate-fade-in-up motion-reduce:animate-none",
        className
      )}
    >
      {/* Icon with subtle styling */}
      <div className="w-16 h-16 mb-5 text-muted-foreground/50 hover-transition hover:scale-105">
        {icon}
      </div>

      {/* Title */}
      {title && (
        <EmptyStateTitle className="text-lg text-foreground font-semibold mb-3">
          {title}
        </EmptyStateTitle>
      )}

      {/* Description */}
      {description && (
        <EmptyStateDescription className="text-sm text-muted-foreground max-w-sm leading-relaxed">
          {description}
        </EmptyStateDescription>
      )}

      {/* Optional action button */}
      {action && <div className="mt-4">{action}</div>}
    </EmptyStateContainer>
  );
}
