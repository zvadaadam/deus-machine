import { ChevronDown, PanelLeftClose } from "lucide-react";
import { SidebarHeader as SidebarHeaderUI, useSidebar } from "@/components/ui/sidebar";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/shared/lib/utils";
import type { SidebarHeaderProps } from "../model/types";

/**
 * SidebarHeader — V2: Jony Ive
 *
 * "The absence of clutter is just a way of making the
 *  things that are there more precious."
 *
 * Layout: [Avatar 24] [Username · Chevron]  ...  [Collapse 18]
 * Padding: 12px vertical, 14px horizontal (matches design spec)
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
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md"
      >
        <Avatar shape="square" className="h-6 w-6 shrink-0 rounded-md">
          <AvatarFallback shape="square" className="rounded-md text-[10px] font-semibold">
            {initials}
          </AvatarFallback>
        </Avatar>
        {isExpanded && (
          <>
            <span className="text-text-primary truncate text-sm font-medium">
              {profile.username}
            </span>
            <ChevronDown className="text-text-muted h-4 w-4 shrink-0" />
          </>
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
