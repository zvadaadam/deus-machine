import { SidebarHeader as SidebarHeaderUI } from "@/components/ui/sidebar";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import type { SidebarHeaderProps } from "../model/types";

/**
 * SidebarHeader Component
 * Displays user profile with settings button
 */
export function SidebarHeader({ profile, onOpenSettings }: SidebarHeaderProps) {
  return (
    <SidebarHeaderUI className="p-2">
      <button
        type="button"
        aria-label="Open settings"
        onClick={onOpenSettings}
        className="group-data-[collapsible=icon]:mx-auto flex items-center gap-3 min-w-0 flex-1 p-2 rounded-lg transition-colors duration-200 ease-out hover:bg-sidebar-accent/60 text-left w-full"
      >
        <Avatar className="h-8 w-8 flex-shrink-0">
          <AvatarFallback className="text-caption">
            {profile.username.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <p className="text-body font-medium truncate group-data-[collapsible=icon]:hidden">
          {profile.username}
        </p>
      </button>
    </SidebarHeaderUI>
  );
}
