import { Plus } from "lucide-react";
import { SidebarFooter as SidebarFooterUI, useSidebar } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import type { SidebarFooterProps } from "../model/types";

/**
 * SidebarFooter Component
 * Displays "Add Repository" button
 * Structure mirrors SidebarHeader for consistency
 */
export function SidebarFooter({ onAddRepository }: SidebarFooterProps) {
  const { state, hoverOpen, isMobile } = useSidebar();
  // Visually collapsed = state is collapsed AND not hover-revealed
  const isCollapsed = state === "collapsed" && !hoverOpen;

  // Tooltip only shows when visually collapsed AND not on mobile
  const showTooltip = isCollapsed && !isMobile;

  return (
    <SidebarFooterUI className="p-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            onClick={() => onAddRepository?.()}
            aria-label="Add Repository"
            className={cn(
              "h-auto w-full justify-start gap-3 rounded-lg p-2",
              "text-muted-foreground",
              "hover:bg-foreground/5 hover:text-foreground"
            )}
          >
            {/* Icon container - 32x32 to match header avatar */}
            <div className="flex h-8 w-8 shrink-0 items-center justify-center">
              <Plus className="h-4 w-4" />
            </div>
            <span className="text-sm">Add Repository</span>
          </Button>
        </TooltipTrigger>
        {showTooltip && (
          <TooltipContent side="right" align="center">
            <p className="text-xs">Add Repository</p>
          </TooltipContent>
        )}
      </Tooltip>
    </SidebarFooterUI>
  );
}
