/**
 * BrowserTabBar — horizontal tab bar for multi-tab browser panel.
 *
 * Each tab uses the shared <TabPill> primitive: [favicon|X crossfade][title].
 * The Globe icon is a favicon placeholder for now.
 */

import { Globe, Plus } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { TabPill } from "@/components/ui/tab-pill";
import type { BrowserTabState } from "../types";
import type { ReactNode } from "react";

interface BrowserTabBarProps {
  tabs: BrowserTabState[];
  activeTabId: string | null;
  onTabSelect: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onTabAdd: () => void;
  toolbarAction?: ReactNode;
}

export function BrowserTabBar({
  tabs,
  activeTabId,
  onTabSelect,
  onTabClose,
  onTabAdd,
  toolbarAction,
}: BrowserTabBarProps) {
  return (
    <div className="border-border-subtle flex h-9 flex-shrink-0 items-center border-b bg-transparent">
      <div
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-2"
        role="tablist"
        aria-label="Browser tabs"
      >
        {tabs.map((tab) => (
          <TabPill
            key={tab.id}
            active={activeTabId === tab.id}
            icon={<Globe className="h-3.5 w-3.5" />}
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
              className="control-interaction text-text-muted hover:bg-foreground/5 hover:text-text-tertiary flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg border-none bg-transparent"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={8}>
            <p className="text-xs">New Tab</p>
          </TooltipContent>
        </Tooltip>
      </div>

      {toolbarAction && <div className="mr-2 flex shrink-0 items-center">{toolbarAction}</div>}
    </div>
  );
}
