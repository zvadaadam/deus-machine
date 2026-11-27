import { useRef, useState } from "react";
import { Hash } from "lucide-react";
import { channelName, type BoardDetail } from "@shared/boards";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/shared/lib/utils";
import { BoardAvatar } from "./BoardAvatar";
import { BoardDetails } from "./BoardDetails";
import { WorkspaceChip } from "./WorkspaceChip";

const card = {
  "aria-label": "Board details",
  collisionPadding: 12,
  sideOffset: 8,
  className:
    "w-80 max-w-(--radix-popper-available-width) max-h-(--radix-popper-available-height) overflow-y-auto p-3",
};

type Shown = "hover" | "title" | "workspaces" | null;

export function BoardHeader({ board }: { board: BoardDetail }) {
  // Hovering the name previews the details; clicking it or the workspace count keeps them open.
  const [shown, show] = useState<Shown>(null);
  // Clicking the name while its hover card shows keeps that card where it is, with no second entrance.
  const [inPlace, setInPlace] = useState(false);
  const title = useRef<HTMLButtonElement>(null);
  const kept = shown === "title" || shown === "workspaces";
  const channel = channelName(board.name);
  const count = Object.keys(board.workspaces).length;
  const details = <BoardDetails board={board} />;
  return (
    <header className="border-border-subtle grid shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 border-b px-3 py-1 md:flex md:h-11 md:px-4 md:py-0">
      <SidebarTrigger className="col-start-1 row-start-1 shrink-0 md:hidden" />
      <h1 className="text-foreground col-start-2 row-start-1 flex min-w-0 text-base font-semibold">
        <HoverCard
          openDelay={500}
          closeDelay={100}
          open={shown === "hover"}
          onOpenChange={(open) => kept || show(open ? "hover" : null)}
        >
          <Popover
            open={shown === "title"}
            onOpenChange={(open) => {
              setInPlace(open && shown === "hover");
              show(open ? "title" : null);
            }}
          >
            <PopoverTrigger asChild>
              <button
                ref={title}
                type="button"
                className="control-interaction hover:bg-control-hover relative -mx-1 min-w-0 rounded-md pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:-inset-y-1.5"
              >
                {/* The hover trigger is not the button: Radix opens a hover card on focus. */}
                <HoverCardTrigger asChild>
                  <span className="flex min-w-0 items-center gap-1 p-1">
                    <BoardAvatar kind="bot" board={board} className="mr-1 size-6" />
                    <Hash aria-hidden className="size-4 shrink-0" />
                    <span className="truncate">{channel}</span>
                  </span>
                </HoverCardTrigger>
              </button>
            </PopoverTrigger>
            <PopoverContent
              {...card}
              align="start"
              className={cn(card.className, inPlace && "data-[state=open]:animate-none")}
            >
              {details}
            </PopoverContent>
          </Popover>
          {!kept && (
            <HoverCardContent
              {...card}
              role="region"
              onPointerDownOutside={(event) => {
                if (title.current?.contains(event.target as Node)) event.preventDefault();
              }}
            >
              {details}
            </HoverCardContent>
          )}
        </HoverCard>
      </h1>
      <div className="col-span-2 col-start-2 row-start-2 mb-1 flex min-w-0 items-center gap-2 md:mb-0">
        <span className="text-text-muted shrink-0 text-xs">
          <span className="hidden md:inline">· </span>
          <strong className="text-foreground font-semibold">Coordinator</strong>
        </span>
        <WorkspaceChip
          id={board.workspace_id}
          name={board.coordinator_name}
          archived={!!board.read_only}
        />
      </div>
      {count > 0 && (
        <Popover
          open={shown === "workspaces"}
          onOpenChange={(open) => show(open ? "workspaces" : null)}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              className="control-interaction text-text-secondary hover:bg-control-hover col-start-3 row-start-1 ml-auto shrink-0 rounded-md px-1.5 py-1 text-xs"
            >
              {count} {count === 1 ? "workspace" : "workspaces"}
            </button>
          </PopoverTrigger>
          <PopoverContent {...card} align="end">
            {details}
          </PopoverContent>
        </Popover>
      )}
    </header>
  );
}
