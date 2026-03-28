/**
 * BrowserTabBar — horizontal tab bar for multi-tab browser panel.
 *
 * Follows TerminalPanel's tab design language:
 * h-9 vibrancy-panel, overflow-x-auto, Globe icon + title + close per tab.
 */

import { Globe, ExternalLink } from "lucide-react";
import { cn } from "@/shared/lib/utils";
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
    <div className="border-border-subtle flex h-9 flex-shrink-0 items-center border-b bg-transparent">
      <div
        className="flex flex-1 items-center gap-1 overflow-x-auto px-2"
        role="tablist"
        aria-label="Browser tabs"
      >
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={cn(
              "flex items-center gap-1 rounded-md pr-1 text-xs whitespace-nowrap transition-colors duration-200 ease select-none",
              activeTabId === tab.id
                ? "bg-bg-raised text-text-secondary font-medium"
                : "text-text-muted hover:bg-foreground/5 hover:text-text-tertiary"
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeTabId === tab.id}
              className="flex min-w-0 cursor-pointer items-center gap-1.5 border-none bg-transparent px-2.5 py-1.5"
              onClick={() => onTabSelect(tab.id)}
            >
              <Globe className="h-3.5 w-3.5 flex-shrink-0 opacity-50" />
              <span className="max-w-[150px] truncate">{tab.title}</span>
            </button>
            <button
              type="button"
              aria-label={`Close ${tab.title}`}
              className="text-text-disabled hover:bg-foreground/8 hover:text-text-tertiary ease relative flex h-4 w-4 cursor-pointer items-center justify-center rounded-sm border-none bg-transparent p-0 text-xs leading-none transition-colors duration-200 before:absolute before:inset-[-12px] before:content-['']"
              onClick={() => onTabClose(tab.id)}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          aria-label="New tab"
          className="text-text-muted hover:bg-foreground/5 hover:text-text-tertiary ease cursor-pointer rounded-md border-none bg-transparent px-2 py-1 text-sm transition-colors duration-200"
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
          className="text-text-disabled hover:bg-foreground/5 hover:text-text-tertiary ease relative mr-2 flex h-6 w-6 flex-shrink-0 cursor-pointer items-center justify-center rounded-md border-none bg-transparent transition-colors duration-200 before:absolute before:inset-[-10px] before:content-['']"
          onClick={onDetach}
          title="Open in separate window"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
