import type { ReactNode } from "react";
import { cn } from "@/shared/lib/utils";

interface ToolResultListProps {
  children: ReactNode;
  className?: string;
  maxHeightClassName?: string;
}

interface ToolResultRowProps {
  children: ReactNode;
  className?: string;
  title?: string;
}

export function ToolResultList({
  children,
  className,
  maxHeightClassName = "max-h-60",
}: ToolResultListProps) {
  return (
    <div
      className={cn(
        "chat-scroll-contain divide-border/40 border-border/60 bg-muted/30 divide-y overflow-x-hidden overflow-y-auto rounded-lg border",
        maxHeightClassName,
        className
      )}
    >
      {children}
    </div>
  );
}

export function ToolResultRow({ children, className, title }: ToolResultRowProps) {
  return (
    <div title={title} className={cn("flex min-w-0 items-center gap-2.5 px-2.5 py-1.5", className)}>
      {children}
    </div>
  );
}
