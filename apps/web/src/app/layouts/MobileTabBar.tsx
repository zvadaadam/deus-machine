/**
 * MobileTabBar -- bottom navigation for mobile web layout.
 *
 * Two tabs: Chat (default) and Code (all-files diff viewer).
 * Badge dot on Code tab when file changes exist.
 * Fixed at the bottom of the mobile flex column (not position:fixed).
 * Safe-area aware for notched iOS devices.
 */

import { MessageSquare, GitBranch } from "lucide-react";
import { cn } from "@/shared/lib/utils";

export type MobileTab = "chat" | "code";

interface MobileTabBarProps {
  activeTab: MobileTab;
  onTabChange: (tab: MobileTab) => void;
  fileChangesCount: number;
}

const tabs: Array<{ id: MobileTab; label: string; icon: typeof MessageSquare }> = [
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "code", label: "Code", icon: GitBranch },
];

export function MobileTabBar({ activeTab, onTabChange, fileChangesCount }: MobileTabBarProps) {
  return (
    <div
      data-slot="mobile-tab-bar"
      role="tablist"
      aria-label="View"
      className="border-border-subtle bg-bg-surface flex flex-shrink-0 items-start border-t pt-2 pb-[env(safe-area-inset-bottom)]"
      style={{ minHeight: "3rem" }}
    >
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const isActive = activeTab === tab.id;
        const showBadge = tab.id === "code" && fileChangesCount > 0;

        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-controls={`mobile-panel-${tab.id}`}
            onClick={() => onTabChange(tab.id)}
            className={cn(
              "relative flex flex-1 flex-col items-center justify-center gap-0.5 transition-colors duration-150",
              isActive ? "text-foreground" : "text-text-muted"
            )}
          >
            <div className="relative">
              <Icon className="h-[18px] w-[18px]" />
              {showBadge && (
                <span className="bg-primary text-primary-foreground absolute -top-1.5 -right-2.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-bold leading-none">
                  {fileChangesCount > 99 ? "99+" : fileChangesCount}
                </span>
              )}
            </div>
            <span className="text-[10px] font-medium">{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}
