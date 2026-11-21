import type { ComponentProps } from "react";
import { cn } from "@/shared/lib/utils";

export function OutputBlock({ className, ...props }: ComponentProps<"pre">) {
  return (
    <pre
      className={cn(
        "overflow-x-auto rounded-lg p-3 font-mono text-xs whitespace-pre-wrap",
        "chat-scroll-contain max-h-96 overflow-y-auto border",
        "bg-muted/50 text-foreground border-border/60",
        className
      )}
      {...props}
    />
  );
}
