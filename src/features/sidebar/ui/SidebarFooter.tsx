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
  const { state, isMobile } = useSidebar();
  const isCollapsed = state === "collapsed";

  // Tooltip only shows when collapsed AND not on mobile (matches SidebarMenuButton behavior)
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
              "hover:bg-foreground/5 hover:text-foreground",
              // Collapsed: center the icon, disable button hover (icon container has its own)
              "group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0 group-data-[collapsible=icon]:hover:bg-transparent"
            )}
          >
            {/* Icon container - 32x32 to match header avatar */}
            <div
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center",
                // Collapsed: subtle hover effect
                "group-data-[collapsible=icon]:hover:bg-foreground/5 group-data-[collapsible=icon]:rounded-lg"
              )}
            >
              <Plus className="h-4 w-4" />
            </div>
            {/* Label - hidden when collapsed */}
            <span className="text-sm group-data-[collapsible=icon]:hidden">Add Repository</span>
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
