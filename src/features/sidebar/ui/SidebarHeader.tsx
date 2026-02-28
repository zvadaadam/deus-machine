import { PanelLeftClose } from "lucide-react";
import { SidebarHeader as SidebarHeaderUI, useSidebar } from "@/components/ui/sidebar";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/shared/lib/utils";
import type { SidebarHeaderProps } from "../model/types";

/**
 * SidebarHeader — V2: Jony Ive
 *
 * Avatar + name. Subtle hover bg signals it's clickable.
 * No chevron — it promised a dropdown but delivered settings.
 */
export function SidebarHeader({
  profile = { username: "User" },
  onOpenSettings,
  onToggleSidebar,
  isExpanded,
}: SidebarHeaderProps) {
  const { isMobile } = useSidebar();
  const initials = profile.username.slice(0, 2).toUpperCase();

  const modKey = typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "⌘" : "Ctrl+";
  const toggleTitle = `${isExpanded ? "Collapse" : "Expand"} sidebar (${modKey}B)`;

  return (
    <SidebarHeaderUI className="flex-row items-center justify-between px-3.5 py-3">
      <button
        type="button"
        aria-label="Open settings"
        onClick={onOpenSettings}
        className="hover:bg-bg-elevated -ml-1 flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-0.5 transition-colors duration-200"
      >
        <Avatar shape="square" className="h-6 w-6 shrink-0 rounded-md">
          <AvatarFallback shape="square" className="rounded-md text-2xs font-semibold">
            {initials}
          </AvatarFallback>
        </Avatar>
        {isExpanded && (
          <span className="text-text-primary truncate text-sm font-medium">{profile.username}</span>
        )}
      </button>

      <button
        type="button"
        onClick={onToggleSidebar}
        aria-label={isExpanded ? "Collapse sidebar" : "Expand sidebar"}
        title={!isMobile ? toggleTitle : undefined}
        className={cn(
          "text-text-muted hover:text-text-tertiary flex h-[18px] w-[18px] shrink-0 items-center justify-center transition-colors duration-150",
          !isExpanded && "opacity-60"
        )}
      >
        <PanelLeftClose className="h-[18px] w-[18px]" />
      </button>
    </SidebarHeaderUI>
  );
}
