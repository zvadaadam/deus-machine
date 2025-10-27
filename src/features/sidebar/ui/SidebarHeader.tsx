import { SidebarHeader as SidebarHeaderUI } from "@/components/ui/sidebar";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
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
        className="group-data-[collapsible=icon]:mx-auto group-data-[collapsible=icon]:justify-center flex items-center gap-3 min-w-0 flex-1 p-2 rounded-lg transition-colors duration-200 ease-out hover:bg-sidebar-accent/60 text-left w-full"
      >
        <Avatar className="h-8 w-8 flex-shrink-0 transition-all duration-[80ms] ease-[cubic-bezier(0.165,0.84,0.44,1)]">
          <AvatarFallback className="text-caption">
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
