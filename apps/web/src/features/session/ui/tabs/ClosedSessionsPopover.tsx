import { useState } from "react";
import { History } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getAgentLogo } from "@/assets/agents";
import { cn } from "@/shared/lib/utils";
import { chatTabLabel, type ClosedSessionTab } from "./types";

const ICON_SIZE = "h-3.5 w-3.5";

interface ClosedSessionsPopoverProps {
  closedTabs: ClosedSessionTab[];
  onTabRestore: (closedTab: ClosedSessionTab) => void;
}

function getClosedTabIcon(agentHarness: ClosedSessionTab["agentHarness"]) {
  const LogoComponent = getAgentLogo(agentHarness);
  if (!LogoComponent) return null;
  return <LogoComponent className={cn(ICON_SIZE, "shrink-0")} />;
}

export function ClosedSessionsPopover({ closedTabs, onTabRestore }: ClosedSessionsPopoverProps) {
  const [open, setOpen] = useState(false);

  if (closedTabs.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Restore closed session"
              className={cn(
                "control-interaction flex items-center justify-center",
                "h-7 shrink-0 rounded-lg px-1.5",
                "text-text-disabled hover:text-text-muted"
              )}
            >
              <History className="h-3.5 w-3.5" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        {!open && (
          <TooltipContent side="bottom" sideOffset={8}>
            <p className="text-xs">Restore closed session (Cmd/Ctrl+Shift+T)</p>
          </TooltipContent>
        )}
      </Tooltip>

      <PopoverContent align="end" sideOffset={6} className="w-56 p-1">
        <p className="text-text-muted px-2 py-1.5 text-xs font-medium">Recently closed</p>
        <div className="max-h-48 overflow-y-auto">
          {closedTabs.map((closedTab) => {
            const label = chatTabLabel(closedTab);
            return (
              <Tooltip key={closedTab.id} delayDuration={300}>
                <TooltipTrigger
                  type="button"
                  onClick={() => {
                    onTabRestore(closedTab);
                    setOpen(false);
                  }}
                  className="control-interaction text-text-secondary hover:bg-bg-raised flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-base"
                >
                  {getClosedTabIcon(closedTab.agentHarness)}
                  <span className="min-w-0 flex-1 truncate pointer-coarse:wrap-anywhere pointer-coarse:whitespace-normal">
                    {label}
                  </span>
                </TooltipTrigger>
                <TooltipContent
                  side="left"
                  onEscapeKeyDown={() => setOpen(false)}
                  className="max-w-[min(20rem,var(--radix-tooltip-content-available-width))] wrap-anywhere"
                >
                  {label}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
