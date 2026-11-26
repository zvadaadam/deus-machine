import { Network } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export const coordinatorDescription =
  "A coordinator starts and directs work in other workspaces and reports to you on a board.";

export function CoordinatorToggle({
  enabled,
  cloud,
  onToggle,
}: {
  enabled: boolean;
  cloud: boolean;
  onToggle: () => void;
}) {
  const reason = cloud
    ? "Coordinators run on this computer. Turn off Cloud to make one."
    : coordinatorDescription;
  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <span
          className="inline-flex"
          tabIndex={cloud ? 0 : undefined}
          aria-label={cloud ? reason : undefined}
        >
          <Button
            type="button"
            variant="ghost"
            size={enabled ? "sm" : "icon-sm"}
            disabled={cloud}
            aria-label="Coordinator"
            aria-pressed={enabled}
            onClick={onToggle}
            className={enabled ? "bg-control-hover text-foreground" : "text-text-muted"}
          >
            <Network className="size-3.5" />
            {enabled && "Coordinator"}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{reason}</TooltipContent>
    </Tooltip>
  );
}
