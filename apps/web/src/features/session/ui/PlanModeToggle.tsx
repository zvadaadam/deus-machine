import { ClipboardList } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function PlanModeToggle({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={onClick}
          aria-label="Exit plan mode"
          className="text-accent-gold bg-accent-gold/8 hover:text-accent-gold hover:bg-accent-gold/12 rounded-full text-xs"
        >
          <ClipboardList className="size-3.5" />
          Plan
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Exit plan mode</TooltipContent>
    </Tooltip>
  );
}
