/**
 * BrowserTabBar — horizontal tab bar for multi-tab browser panel.
 *
 * Follows TerminalPanel's tab design language:
 * h-9 vibrancy-panel, overflow-x-auto, Globe icon + title + close per tab.
 */

import { Globe } from "lucide-react";
import type { BrowserTabState } from "../types";

interface BrowserTabBarProps {
  tabs: BrowserTabState[];
  activeTabId: string | null;
  onTabSelect: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onTabAdd: () => void;
}

export function BrowserTabBar({
  tabs,
  activeTabId,
  onTabSelect,
  onTabClose,
  onTabAdd,
}: BrowserTabBarProps) {
  return (
    <div className="vibrancy-panel border-border/40 flex h-9 flex-shrink-0 items-center border-b">
      <div className="flex flex-1 items-center gap-0.5 overflow-x-auto px-2" role="tablist" aria-label="Browser tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTabId === tab.id}
            className={`flex cursor-pointer items-center gap-1.5 rounded-t px-2 py-1 text-xs whitespace-nowrap transition-colors duration-200 ease-out select-none ${
              activeTabId === tab.id
                ? "bg-background text-foreground font-medium"
                : "bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
            onClick={() => onTabSelect(tab.id)}
          >
            <Globe className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="max-w-[150px] truncate">{tab.title}</span>
            <button
              type="button"
              aria-label={`Close ${tab.title}`}
              className="text-muted-foreground hover:bg-muted/80 hover:text-foreground flex h-3 w-3 cursor-pointer items-center justify-center rounded-sm border-none bg-transparent p-0 text-sm leading-none transition-colors duration-200 ease-out"
              onClick={(e) => {
                e.stopPropagation();
                onTabClose(tab.id);
              }}
            >
              ×
            </button>
          </button>
        ))}
        <button
          type="button"
          aria-label="New tab"
          className="text-muted-foreground hover:bg-muted/80 hover:text-foreground cursor-pointer rounded border-none bg-transparent px-1.5 py-0.5 text-sm transition-colors duration-200 ease-out"
          onClick={onTabAdd}
          title="New tab"
        >
          +
        </button>
      </div>
    </div>
  );
}
