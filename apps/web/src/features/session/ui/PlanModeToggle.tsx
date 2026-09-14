// Plan mode toggle — toolbar button that enables permissionMode: "plan".

import { ClipboardList } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/shared/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface PlanModeToggleProps {
  enabled: boolean;
  onClick: () => void;
}

export function PlanModeToggle({ enabled, onClick }: PlanModeToggleProps) {
  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onClick}
          aria-pressed={enabled}
          aria-label={enabled ? "Plan mode (active)" : "Plan mode"}
          className={cn(
            "focus-visible:ring-1",
            enabled
              ? "text-accent-gold bg-accent-gold/8 hover:text-accent-gold hover:bg-accent-gold/12"
              : "text-text-muted"
          )}
        >
          <ClipboardList className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {enabled ? "Disable plan mode" : "Enable plan mode"}
      </TooltipContent>
    </Tooltip>
  );
}
