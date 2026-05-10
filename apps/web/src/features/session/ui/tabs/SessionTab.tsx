import type { KeyboardEvent, RefCallback } from "react";
import { getAgentLogo } from "@/assets/agents";
import { TabPill } from "@/components/ui/tab-pill";
import { cn } from "@/shared/lib/utils";
import { CircularPixelGrid } from "../CircularPixelGrid";
import type { ChatTab } from "./types";

const AGENT_ICON_SIZE = "h-3.5 w-3.5";

interface SessionTabProps {
  tab: ChatTab;
  isActive: boolean;
  isWorking: boolean;
  isUnread: boolean;
  canClose: boolean;
  onSelect: () => void;
  onClose?: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  tabRef?: RefCallback<HTMLButtonElement>;
}

function renderStatusIcon(tab: ChatTab, isWorking: boolean, isUnread: boolean) {
  if (isWorking) {
    return <CircularPixelGrid variant="generating" size={14} resolution={8} />;
  }

  if (isUnread) {
    return <span className="bg-accent-gold h-2 w-2 rounded-full" />;
  }

  const LogoComponent = getAgentLogo(tab.agentHarness);
  if (!LogoComponent) return null;
  return <LogoComponent className={cn(AGENT_ICON_SIZE, "shrink-0")} />;
}

export function SessionTab({
  tab,
  isActive,
  isWorking,
  isUnread,
  canClose,
  onSelect,
  onClose,
  onKeyDown,
  tabRef,
}: SessionTabProps) {
  const closeProps =
    canClose && onClose ? { onClose, closeAriaLabel: `Close ${tab.label} tab` } : {};

  return (
    <TabPill
      active={isActive}
      icon={renderStatusIcon(tab, isWorking, isUnread)}
      onSelect={onSelect}
      onTitleKeyDown={onKeyDown}
      titleTabIndex={isActive ? 0 : -1}
      titleRef={tabRef}
      className={cn(
        "max-w-[200px] min-w-[80px] text-base",
        !isActive && isUnread && "text-text-secondary hover:text-text-secondary"
      )}
      {...closeProps}
    >
      {tab.label}
    </TabPill>
  );
}
