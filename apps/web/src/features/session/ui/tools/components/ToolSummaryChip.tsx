import type { ReactNode } from "react";
import { cn } from "@/shared/lib/utils";

const CHIP_TONE_CLASSES = {
  bare: "bg-transparent text-foreground/80 rounded-sm",
  muted: "bg-muted/60 text-foreground/80",
  info: "bg-info/15 text-info",
  primary: "bg-primary/15 text-primary px-2",
} as const;

type ToolSummaryChipTone = keyof typeof CHIP_TONE_CLASSES;

interface ToolSummaryChipProps {
  children: ReactNode;
  tone?: ToolSummaryChipTone;
  className?: string;
}

export function ToolSummaryChip({ children, tone = "muted", className }: ToolSummaryChipProps) {
  return (
    <span
      className={cn(
        "rounded-md px-1.5 py-0.5 font-mono text-sm font-normal",
        CHIP_TONE_CLASSES[tone],
        className
      )}
    >
      {children}
    </span>
  );
}
