// Plan mode toggle — toolbar button that enables permissionMode: "plan".
// Follows ThinkingIndicator pattern: small button with tooltip in the input toolbar.

import { ClipboardList } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface PlanModeToggleProps {
  enabled: boolean;
  onClick: () => void;
  disabled?: boolean;
}

export function PlanModeToggle({ enabled, onClick, disabled }: PlanModeToggleProps) {
  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          aria-pressed={enabled}
          aria-label={enabled ? "Plan mode (active)" : "Plan mode"}
          className={cn(
            "flex h-8 items-center justify-center rounded-lg px-2",
            "ease transition-colors duration-200",
            "hover:bg-accent",
            "focus-visible:ring-ring focus-visible:ring-1 focus-visible:outline-none",
            enabled ? "text-amber-500" : "text-muted-foreground opacity-60",
            disabled && "pointer-events-none opacity-30"
          )}
        >
          <ClipboardList className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {disabled
          ? "Plan mode not available for this model"
          : enabled
            ? "Disable plan mode"
            : "Enable plan mode"}
      </TooltipContent>
    </Tooltip>
  );
}
