import type { KeyboardEvent, RefCallback, SyntheticEvent } from "react";
import { Link, MessageSquare, X } from "lucide-react";
import { getAgentLogo } from "@/assets/agents";
import { ContextMenu, ContextMenuItem } from "@/components/ui/context-menu";
import { TabPill } from "@/components/ui/tab-pill";
import { copyWorkspaceLink } from "@/features/workspace/lib/workspaceAddress";
import { cn } from "@/shared/lib/utils";
import { CircularPixelGrid } from "../CircularPixelGrid";
import { chatTabLabel, getChatTabSessionId, type ChatTab } from "./types";

const AGENT_ICON_SIZE = "h-3.5 w-3.5";

function keepTouchForDrag(event: SyntheticEvent) {
  if ("pointerType" in event.nativeEvent && event.nativeEvent.pointerType === "touch")
    event.preventDefault();
}

interface SessionTabProps {
  workspaceId: string;
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
  workspaceId,
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
  const sessionId = getChatTabSessionId(tab);
  const label = chatTabLabel(tab);
  const closeProps = canClose && onClose ? { onClose, closeAriaLabel: `Close ${label} tab` } : {};

  const pill = (
    <TabPill
      active={isActive}
      icon={renderStatusIcon(tab, isWorking, isUnread)}
      onSelect={onSelect}
      onTitleKeyDown={onKeyDown}
      titleTabIndex={isActive ? 0 : -1}
      titleRef={tabRef}
      className={cn(
        "max-w-[200px] min-w-[80px] text-sm",
        !isActive && isUnread && "text-text-secondary hover:text-text-secondary"
      )}
      {...closeProps}
    >
      {label}
    </TabPill>
  );
  if (!sessionId) return pill;
  return (
    <ContextMenu
      trigger={
        <div onPointerDown={keepTouchForDrag} onContextMenu={keepTouchForDrag}>
          {pill}
        </div>
      }
    >
      {!isActive && (
        <ContextMenuItem onSelect={onSelect}>
          <MessageSquare />
          Open chat
        </ContextMenuItem>
      )}
      <ContextMenuItem onSelect={() => copyWorkspaceLink({ workspaceId, sessionId })}>
        <Link />
        Copy link
      </ContextMenuItem>
      {canClose && onClose && (
        <ContextMenuItem onSelect={onClose}>
          <X />
          Close tab
        </ContextMenuItem>
      )}
    </ContextMenu>
  );
}
