import { Flag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

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
    ? "Coordinators run on this computer"
    : "Create this workspace as a coordinator so its chats can run boards";
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
            size="icon-sm"
            disabled={cloud}
            aria-label="Coordinator"
            aria-pressed={enabled}
            onClick={onToggle}
            className={
              enabled
                ? "bg-accent-gold/8 text-accent-gold hover:bg-accent-gold/12 hover:text-accent-gold"
                : "text-text-muted"
            }
          >
            <Flag className="size-3.5" />
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{reason}</TooltipContent>
    </Tooltip>
  );
}
