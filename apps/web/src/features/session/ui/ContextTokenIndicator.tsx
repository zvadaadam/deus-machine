import { cn } from "@/shared/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Fallback max tokens when agent-server hasn't reported the real model limit */
const DEFAULT_MAX_TOKENS = 200_000;

interface ContextTokenIndicatorProps {
  contextTokenCount: number;
  contextUsedPercent: number;
  /** When provided and context > 80%, clicking the indicator triggers compact */
  onCompact?: () => void;
  className?: string;
}

export function ContextTokenIndicator({
  contextTokenCount,
  contextUsedPercent,
  onCompact,
  className,
}: ContextTokenIndicatorProps) {
  if (contextTokenCount === 0 && contextUsedPercent === 0) return null;

  // Prefer DB percent (agent-server knows the model's real max), fallback to estimate
  const percentage =
    contextUsedPercent > 0
      ? Math.min(contextUsedPercent, 100)
      : Math.min((contextTokenCount / DEFAULT_MAX_TOKENS) * 100, 100);

  const isHigh = percentage > 80;
  const canCompact = isHigh && !!onCompact;
  const tooltipText = `Context: ${contextTokenCount.toLocaleString()} tokens (${percentage.toFixed(1)}%)${canCompact ? " — click to compact" : ""}`;

  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={canCompact ? onCompact : undefined}
          aria-label={tooltipText}
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-lg",
            "focus-visible:ring-ring focus-visible:ring-1 focus-visible:outline-none",
            isHigh ? "text-warning" : "text-muted-foreground",
            canCompact && "hover:bg-accent cursor-pointer",
            className
          )}
        >
          <svg aria-hidden="true" className="size-3.5 shrink-0 -rotate-90" viewBox="0 0 16 16">
            <circle
              cx="8"
              cy="8"
              r="6"
              fill="transparent"
              stroke="currentColor"
              strokeWidth="2"
              className="text-muted-foreground/30"
            />
            <circle
              cx="8"
              cy="8"
              r="6"
              fill="transparent"
              stroke="currentColor"
              strokeWidth="2"
              strokeDasharray={`${(percentage / 100) * 37.7} 37.7`}
              strokeLinecap="round"
              className="transition-[stroke-dasharray] duration-300 motion-reduce:transition-none"
            />
          </svg>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltipText}</TooltipContent>
    </Tooltip>
  );
}
