import { ChevronDown, PanelLeftClose } from "lucide-react";
import { SidebarHeader as SidebarHeaderUI, useSidebar } from "@/components/ui/sidebar";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
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

  // Platform-aware modifier key for keyboard shortcut display
  const modKey = typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "⌘" : "Ctrl+";
  const toggleTitle = `${isExpanded ? "Collapse" : "Expand"} sidebar (${modKey}B)`;

  return (
    <SidebarHeaderUI className="flex-row items-center justify-between py-2.5">
      <Button
        variant="ghost"
        aria-label="Open settings"
        onClick={onOpenSettings}
        className={cn(
          "flex min-w-0 flex-1 items-center justify-start gap-2 rounded-md px-1 py-1.5",
          "has-[>svg]:px-1"
        )}
      >
        <Avatar shape="square" className="h-7 w-7 shrink-0 rounded-md">
          <AvatarFallback shape="square" className="rounded-md text-[11px] font-semibold">
            {initials}
          </AvatarFallback>
        </Avatar>
        {isExpanded && (
          <>
            <span className="truncate text-sm font-semibold">{profile.username}</span>
            <ChevronDown className="text-muted-foreground h-4 w-4 shrink-0" />
          </>
        )}
      </Button>

      <Button
        variant="ghost"
        size="icon"
        onClick={onToggleSidebar}
        aria-label={isExpanded ? "Collapse sidebar" : "Expand sidebar"}
        title={!isMobile ? toggleTitle : undefined}
        className={cn("text-muted-foreground h-8 w-8 shrink-0", !isExpanded && "opacity-80")}
      >
        <PanelLeftClose className="h-4 w-4" />
      </Button>
    </SidebarHeaderUI>
  );
}
