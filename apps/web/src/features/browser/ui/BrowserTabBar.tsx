/**
 * BrowserTabBar — horizontal tab bar for multi-tab browser panel.
 *
 * Layout per tab: [icon-slot][title]. The icon slot shows the favicon (a
 * Globe placeholder today — swap for a real favicon later) at rest and
 * cross-fades to an X on tab hover (skill: Contextual Icon Animations —
 * scale 0.25→1, opacity 0→1, blur 4px→0, CSS-only, both icons kept in
 * DOM so enter + exit animate without a motion dep). Click the slot to
 * close; click the title to select.
 */

import { Globe, Plus, X, Maximize2, Minimize2 } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import type { BrowserTabState } from "../types";
import { browserWindowActions, useBrowserWindowStore } from "../store/browserWindowStore";

interface BrowserTabBarProps {
  tabs: BrowserTabState[];
  activeTabId: string | null;
  onTabSelect: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onTabAdd: () => void;
  /** Workspace owning this browser — enables the focus-mode toggle at the
   *  right edge of the tab row. Null = no workspace context (e.g. tests). */
  workspaceId?: string | null;
}

// Skill's CSS-only icon cross-fade curve.
const ICON_CROSS_FADE =
  "transition-[opacity,filter,scale] duration-200 ease-[cubic-bezier(0.2,0,0,1)]";

export function BrowserTabBar({
  tabs,
  activeTabId,
  onTabSelect,
  onTabClose,
  onTabAdd,
  workspaceId,
}: BrowserTabBarProps) {
  const focusMode = useBrowserWindowStore((s) =>
    workspaceId ? (s.focusModeByWorkspace[workspaceId] ?? false) : false
  );

  return (
    <div className="border-border-subtle flex h-9 flex-shrink-0 items-center border-b bg-transparent">
      <div
        className="flex flex-1 items-center gap-1 overflow-x-auto px-2"
        role="tablist"
        aria-label="Browser tabs"
      >
        {tabs.map((tab) => {
          const isActive = activeTabId === tab.id;
          return (
            <div
              key={tab.id}
              className={cn(
                "group flex h-7 items-center rounded-md text-xs whitespace-nowrap transition-colors duration-200 ease-out select-none",
                isActive
                  ? "bg-bg-raised text-text-secondary font-medium"
                  : "text-text-muted hover:bg-foreground/5 hover:text-text-tertiary"
              )}
            >
              {/* Icon slot — favicon (Globe placeholder) at rest, X on tab hover. */}
              <button
                type="button"
                aria-label={`Close ${tab.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onTabClose(tab.id);
                }}
                className={cn(
                  "relative flex h-full w-7 shrink-0 cursor-pointer items-center justify-center rounded-l-md border-none bg-transparent p-0",
                  "transition-[background-color,scale] duration-150 ease-out",
                  "hover:bg-foreground/10 active:scale-[0.96]"
                )}
              >
                {/* Favicon (rest state) — full opacity so it reads as identity. */}
                <span
                  className={cn(
                    "absolute inset-0 grid place-items-center",
                    ICON_CROSS_FADE,
                    "group-hover:scale-[0.25] group-hover:opacity-0 group-hover:blur-[4px]"
                  )}
                >
                  <Globe strokeWidth={1.5} className="h-3.5 w-3.5" />
                </span>
                {/* Close (hover state) — pops in when the whole tab is hovered. */}
                <span
                  className={cn(
                    "absolute inset-0 grid scale-[0.25] place-items-center opacity-0 blur-[4px]",
                    ICON_CROSS_FADE,
                    "group-hover:scale-100 group-hover:opacity-100 group-hover:blur-none"
                  )}
                >
                  <X strokeWidth={1.75} className="h-3.5 w-3.5" />
                </span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => onTabSelect(tab.id)}
                className="flex h-full min-w-0 cursor-pointer items-center border-none bg-transparent pr-2.5 pl-0.5 text-left"
              >
                <span className="max-w-[150px] truncate">{tab.title}</span>
              </button>
            </div>
          );
        })}
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="New tab"
              onClick={onTabAdd}
              className="text-text-muted hover:bg-foreground/5 hover:text-text-tertiary flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md border-none bg-transparent transition-[color,background-color,scale] duration-150 ease-out active:scale-[0.96]"
            >
              <Plus strokeWidth={1.75} className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={8}>
            <p className="text-xs">New Tab</p>
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Focus-mode toggle — right edge of the browser tab row. Collapses
       *  the chat panel and overlays a floating composer over this browser.
       *  Kept here (not in the content-tab header) so it sits next to the
       *  browser surface it actually affects. */}
      {workspaceId && (
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={focusMode ? "Exit focus mode" : "Enter focus mode"}
              aria-pressed={focusMode}
              onClick={() => browserWindowActions.toggleFocusMode(workspaceId)}
              className={cn(
                "mr-2 flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border-none bg-transparent px-2 text-xs font-medium",
                "transition-[color,background-color,scale] duration-150 ease-out active:scale-[0.96]",
                focusMode
                  ? "text-primary bg-primary/10 hover:bg-primary/15"
                  : "text-text-muted hover:text-text-tertiary hover:bg-foreground/5"
              )}
            >
              {focusMode ? (
                <Minimize2 strokeWidth={1.75} className="h-3.5 w-3.5" />
              ) : (
                <Maximize2 strokeWidth={1.75} className="h-3.5 w-3.5" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={8}>
            <p className="text-xs">
              {focusMode
                ? "Exit focus mode (Esc)"
                : "Focus mode — collapse chat, floating composer"}
            </p>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
