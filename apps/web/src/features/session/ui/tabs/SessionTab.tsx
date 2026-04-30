import type { KeyboardEvent, RefCallback } from "react";
import { X } from "lucide-react";
import { getAgentLogo } from "@/assets/agents";
import { cn } from "@/shared/lib/utils";
import { CircularPixelGrid } from "../CircularPixelGrid";
import type { ChatTab } from "./types";

const ICON_CROSS_FADE =
  "transition-[opacity,filter,scale] duration-200 ease-[cubic-bezier(0.2,0,0,1)]";
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
  return (
    <div
      className={cn(
        "group flex h-7 max-w-[200px] min-w-[80px] items-center overflow-hidden rounded-lg",
        "text-base font-normal whitespace-nowrap transition-colors duration-150 select-none",
        isActive
          ? "bg-bg-raised text-text-secondary"
          : isUnread
            ? "text-text-secondary"
            : "text-text-muted hover:text-text-tertiary"
      )}
    >
      {canClose && onClose ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Close ${tab.label} tab`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          className={cn(
            "relative flex h-full w-7 shrink-0 items-center justify-center rounded-l-lg border-none bg-transparent p-0",
            "transition-[background-color,scale] duration-150 ease-out",
            "hover:bg-foreground/10 active:scale-[0.96]"
          )}
        >
          <span
            className={cn(
              "absolute inset-0 grid place-items-center",
              ICON_CROSS_FADE,
              "group-hover:scale-[0.25] group-hover:opacity-0 group-hover:blur-[4px]"
            )}
          >
            {renderStatusIcon(tab, isWorking, isUnread)}
          </span>
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
      ) : (
        <span className="flex h-full w-7 shrink-0 items-center justify-center">
          {renderStatusIcon(tab, isWorking, isUnread)}
        </span>
      )}

      <button
        ref={tabRef}
        type="button"
        role="tab"
        aria-selected={isActive}
        tabIndex={isActive ? 0 : -1}
        onClick={onSelect}
        onKeyDown={onKeyDown}
        className="flex h-full min-w-0 flex-1 cursor-pointer items-center border-none bg-transparent pr-2.5 pl-0.5 text-left text-inherit"
      >
        <span className="block truncate">{tab.label}</span>
      </button>
    </div>
  );
}
