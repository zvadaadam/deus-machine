import { PanelLeftClose, SquarePen } from "lucide-react";
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
  onNewSession,
  isExpanded,
}: SidebarHeaderProps) {
  const { isMobile } = useSidebar();
  const initials = profile.username.slice(0, 2).toUpperCase();

  const modKey = typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "⌘" : "Ctrl+";
  const toggleTitle = `${isExpanded ? "Collapse" : "Expand"} sidebar (${modKey}B)`;

  return (
    <SidebarHeaderUI className="drag-region flex-row items-center justify-between gap-1 px-1.5 py-1.5">
      <button
        type="button"
        aria-label="Open settings"
        onClick={onOpenSettings}
        className="hover:bg-foreground/[0.04] flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 transition-colors duration-200"
      >
        <Avatar shape="square" className="h-6 w-6 shrink-0 rounded-md">
          <AvatarFallback shape="square" className="text-2xs rounded-md font-semibold">
            {initials}
          </AvatarFallback>
        </Avatar>
        {isExpanded && (
          <span className="text-text-primary truncate text-sm font-medium">{profile.username}</span>
        )}
      </button>

      <div className="flex items-center gap-0.5">
        {onNewSession && (
          <button
            type="button"
            onClick={onNewSession}
            aria-label="New session"
            title={`New session (${modKey}N)`}
            className="text-text-muted hover:text-text-tertiary hover:bg-foreground/[0.04] flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors duration-150"
          >
            <SquarePen className="h-[16px] w-[16px]" />
          </button>
        )}

        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label={isExpanded ? "Collapse sidebar" : "Expand sidebar"}
          title={!isMobile ? toggleTitle : undefined}
          className={cn(
            "text-text-muted hover:text-text-tertiary hover:bg-foreground/[0.04] flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors duration-150",
            !isExpanded && "opacity-60"
          )}
        >
          <PanelLeftClose className="h-[18px] w-[18px]" />
        </button>
      </div>
    </SidebarHeaderUI>
  );
}
