/**
 * BrowserTabBar — horizontal tab bar for multi-tab browser panel.
 *
 * Follows TerminalPanel's tab design language:
 * h-9 vibrancy-panel, overflow-x-auto, Globe icon + title + close per tab.
 */

import { Globe, ExternalLink } from "lucide-react";
import type { BrowserTabState } from "../types";

interface BrowserTabBarProps {
  tabs: BrowserTabState[];
  activeTabId: string | null;
  onTabSelect: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onTabAdd: () => void;
  /** Pop-out all browser tabs into a separate window */
  onDetach?: () => void;
}

export function BrowserTabBar({
  tabs,
  activeTabId,
  onTabSelect,
  onTabClose,
  onTabAdd,
  onDetach,
}: BrowserTabBarProps) {
  return (
    <div className="vibrancy-panel border-border/40 flex h-9 flex-shrink-0 items-center border-b">
      <div
        className="flex flex-1 items-center gap-0.5 overflow-x-auto px-2"
        role="tablist"
        aria-label="Browser tabs"
      >
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`flex items-center gap-1 rounded-t pr-1 text-xs whitespace-nowrap transition-colors duration-200 ease-out select-none ${
              activeTabId === tab.id
                ? "bg-background text-foreground font-medium"
                : "bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeTabId === tab.id}
              className="flex min-w-0 cursor-pointer items-center gap-1.5 border-none bg-transparent px-2 py-1"
              onClick={() => onTabSelect(tab.id)}
            >
              <Globe className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="max-w-[150px] truncate">{tab.title}</span>
            </button>
            <button
              type="button"
              aria-label={`Close ${tab.title}`}
              className="text-muted-foreground hover:bg-muted/80 hover:text-foreground relative flex h-3 w-3 cursor-pointer items-center justify-center rounded-sm border-none bg-transparent p-0 text-sm leading-none transition-colors duration-200 ease-out before:absolute before:inset-[-16px] before:content-['']"
              onClick={() => onTabClose(tab.id)}
            >
              ×
            </button>
          </div>
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

      {onDetach && (
        <button
          type="button"
          aria-label="Open browser in separate window"
          className="text-muted-foreground hover:bg-muted/80 hover:text-foreground relative mr-2 flex h-6 w-6 flex-shrink-0 cursor-pointer items-center justify-center rounded border-none bg-transparent transition-colors duration-200 ease-out before:absolute before:inset-[-10px] before:content-['']"
          onClick={onDetach}
          title="Open in separate window"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
