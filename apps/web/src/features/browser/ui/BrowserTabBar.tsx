/**
 * BrowserTabBar — horizontal tab bar for multi-tab browser panel.
 *
 * Each tab uses the shared <TabPill> primitive: [favicon|X crossfade][title].
 * The Globe icon is a favicon placeholder for now.
 */

import { Globe, Plus, Maximize2, Minimize2 } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { TabPill } from "@/components/ui/tab-pill";
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
        {tabs.map((tab) => (
          <TabPill
            key={tab.id}
            active={activeTabId === tab.id}
            icon={<Globe strokeWidth={1.5} className="h-3.5 w-3.5" />}
            onSelect={() => onTabSelect(tab.id)}
            onClose={() => onTabClose(tab.id)}
            closeAriaLabel={`Close ${tab.title}`}
            className="max-w-[150px]"
          >
            {tab.title}
          </TabPill>
        ))}
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
