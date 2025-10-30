import { SidebarHeader as SidebarHeaderUI } from "@/components/ui/sidebar";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/shared/lib/utils";
import type { SidebarHeaderProps } from "../model/types";

/**
 * SidebarHeader Component
 * Displays user profile with settings button
 */
export function SidebarHeader({
  profile = { username: 'User' },
  onOpenSettings
}: SidebarHeaderProps) {
  return (
    <SidebarHeaderUI className="p-2">
      <button
        type="button"
        aria-label="Open settings"
        onClick={onOpenSettings}
        className={cn(
          "flex items-center gap-3",
          // Expanded: full width with padding, rounded-lg container, hover background
          "w-full text-left min-w-0 flex-1 p-2 rounded-lg",
          "transition-colors duration-200 ease-out hover:bg-sidebar-accent/60",
          // Collapsed: centered, no padding, no flex-1, no hover background (avatar handles its own hover)
          "group-data-[collapsible=icon]:w-auto",
          "group-data-[collapsible=icon]:flex-none",
          "group-data-[collapsible=icon]:p-0",
          "group-data-[collapsible=icon]:mx-auto",
          "group-data-[collapsible=icon]:rounded-none",
          "group-data-[collapsible=icon]:hover:bg-transparent"
        )}
      >
        <Avatar
          shape="square"
          className={cn(
            "h-8 w-8 flex-shrink-0",
            "transition-all duration-[80ms] ease-[cubic-bezier(0.165,0.84,0.44,1)]",
            // Collapsed: subtle hover lift effect like repository badges
            "group-data-[collapsible=icon]:hover:scale-105 group-data-[collapsible=icon]:hover:shadow-sm"
          )}
        >
          <AvatarFallback shape="square" className="text-caption">
            {profile.username.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <p className="text-body font-medium truncate transition-opacity duration-[80ms] ease-[cubic-bezier(0.165,0.84,0.44,1)] group-data-[collapsible=icon]:opacity-0 group-data-[collapsible=icon]:w-0 group-data-[collapsible=icon]:overflow-hidden">
          {profile.username}
        </p>
      </button>
    </SidebarHeaderUI>
  );
}
