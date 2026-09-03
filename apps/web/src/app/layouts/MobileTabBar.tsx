/**
 * MobileTabBar -- bottom navigation for mobile web layout.
 *
 * Chat (default) and Code (all-files diff viewer); a cloud computer adds
 * Simulator — the hosted device is billable, and a phone must be able to see
 * and stop it. Badge count on Code when file changes exist; a live dot on
 * Simulator while the device is up.
 * Fixed at the bottom of the mobile flex column (not position:fixed).
 * Safe-area aware for notched iOS devices.
 */

import { MessageSquare, GitBranch, Smartphone } from "lucide-react";
import { cn } from "@/shared/lib/utils";

export type MobileTab = "chat" | "code" | "simulator";

interface MobileTabBarProps {
  activeTab: MobileTab;
  onTabChange: (tab: MobileTab) => void;
  fileChangesCount: number;
  /** Cloud computers only: the hosted-device tab. */
  showSimulator?: boolean;
  /** The hosted device is running (and billing) — shown as a dot. */
  simulatorLive?: boolean;
}

const BASE_TABS: Array<{ id: MobileTab; label: string; icon: typeof MessageSquare }> = [
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "code", label: "Code", icon: GitBranch },
];
const SIMULATOR_TAB = { id: "simulator" as const, label: "Simulator", icon: Smartphone };

export function MobileTabBar({
  activeTab,
  onTabChange,
  fileChangesCount,
  showSimulator = false,
  simulatorLive = false,
}: MobileTabBarProps) {
  const tabs = showSimulator ? [...BASE_TABS, SIMULATOR_TAB] : BASE_TABS;
  return (
    <div
      data-slot="mobile-tab-bar"
      role="tablist"
      aria-label="View"
      className="border-border-subtle bg-bg-surface flex min-h-12 flex-shrink-0 items-start border-t pt-2 pb-[env(safe-area-inset-bottom)]"
    >
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const isActive = activeTab === tab.id;
        const showBadge = tab.id === "code" && fileChangesCount > 0;

        return (
          <button
            key={tab.id}
            id={`mobile-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-controls={`mobile-panel-${tab.id}`}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onTabChange(tab.id)}
            className={cn(
              "relative flex flex-1 flex-col items-center justify-center gap-0.5 transition-colors duration-150",
              isActive ? "text-foreground" : "text-text-muted"
            )}
          >
            <div className="relative">
              <Icon className="h-[18px] w-[18px]" />
              {showBadge && (
                <span className="bg-primary text-primary-foreground absolute -top-1.5 -right-2.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] leading-none font-bold">
                  {fileChangesCount > 99 ? "99+" : fileChangesCount}
                </span>
              )}
              {tab.id === "simulator" && simulatorLive && (
                <span
                  aria-label="Device live"
                  className="bg-success absolute -top-0.5 -right-1.5 h-2 w-2 rounded-full"
                />
              )}
            </div>
            <span className="text-[10px] font-medium">{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}
