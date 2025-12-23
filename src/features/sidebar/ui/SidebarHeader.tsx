import { PanelLeft } from "lucide-react";
import { SidebarHeader as SidebarHeaderUI, useSidebar } from "@/components/ui/sidebar";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import type { SidebarHeaderProps } from "../model/types";

/**
 * SidebarHeader Component
 * Displays user profile with settings button + sidebar toggle
 * Layout: [Avatar] [Username] ... [Toggle]
 */
export function SidebarHeader({
  profile = { username: "User" },
  onOpenSettings,
  onToggleSidebar,
  isExpanded,
}: SidebarHeaderProps) {
  const { isMobile } = useSidebar();
  const initials = profile.username.slice(0, 2).toUpperCase();

  // Show tooltip on desktop to help users discover the keyboard shortcut
  const showTooltip = !isMobile;

  // Platform-aware modifier key for keyboard shortcut display
  const modKey = typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "⌘" : "Ctrl+";

  return (
    <SidebarHeaderUI className="p-2">
      {/* Expanded: Horizontal row with avatar, name, and toggle */}
      {/* Collapsed: Vertical stack with toggle on top, avatar below */}
      <div
        className={cn(
          "flex items-center gap-2",
          // Collapsed: vertical stack, centered
          "group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:gap-2"
        )}
      >
        {/* Toggle Button - Right side when expanded, top when collapsed */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={onToggleSidebar}
              aria-label={isExpanded ? "Collapse sidebar" : "Expand sidebar"}
              className={cn(
                "h-8 w-8 shrink-0",
                // Expanded: filled/active state, positioned at end
                isExpanded && "bg-foreground/5 text-foreground hover:bg-foreground/10 order-last",
                // Collapsed: outline/inactive state, positioned at top
                !isExpanded &&
                  "text-muted-foreground hover:bg-foreground/5 hover:text-foreground order-first"
              )}
            >
              <PanelLeft className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          {showTooltip && (
            <TooltipContent side="right" align="center">
              <p className="flex items-center gap-2 text-xs">
                <span>{isExpanded ? "Collapse" : "Expand"} sidebar</span>
                <kbd className="font-mono text-xs opacity-60">{modKey}B</kbd>
              </p>
            </TooltipContent>
          )}
        </Tooltip>

        {/* Settings Button - Avatar + Name */}
        <Button
          variant="ghost"
          aria-label="Open settings"
          onClick={onOpenSettings}
          className={cn(
            "h-auto min-w-0 flex-1 justify-start gap-3 rounded-lg p-2",
            "hover:bg-foreground/5",
            // Collapsed: no flex-1, centered, no hover background
            "group-data-[collapsible=icon]:flex-none",
            "group-data-[collapsible=icon]:p-0",
            "group-data-[collapsible=icon]:hover:bg-transparent"
          )}
        >
          <Avatar
            shape="square"
            className={cn(
              "h-8 w-8 shrink-0",
              "transition-all duration-200 ease-out",
              // Collapsed: subtle hover lift effect
              "group-data-[collapsible=icon]:hover:scale-105 group-data-[collapsible=icon]:hover:shadow-sm"
            )}
          >
            <AvatarFallback shape="square" className="text-xs">
              {initials}
            </AvatarFallback>
          </Avatar>
          {/* Username - hidden when collapsed */}
          <span
            className={cn("truncate text-sm font-medium", "group-data-[collapsible=icon]:hidden")}
          >
            {profile.username}
          </span>
        </Button>
      </div>
    </SidebarHeaderUI>
  );
}
