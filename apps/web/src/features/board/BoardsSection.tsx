import { useUnreadStore } from "@/features/session/store/unreadStore";
import { AnimatePresence } from "framer-motion";
import { Collapse } from "@/components/ui/collapse";
import { Hash } from "lucide-react";
import { useSidebar } from "@/components/ui/sidebar";
import { Glide } from "@/components/ui/glide";
import { SidebarRow, SidebarRowMain } from "@/features/sidebar/ui/SidebarRow";
import { useBoardAddress, openBoard } from "./address";
import { channelName } from "@shared/boards";
import { useBoards, useBoardSeenScope } from "./queries";

export function BoardsSection() {
  const { data } = useBoards();
  const scope = useBoardSeenScope();
  const seen = useUnreadStore((s) => s.seenBoards);
  const selected = useBoardAddress()?.boardId;
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <AnimatePresence initial={false}>
      {!!data?.length && (
        <Collapse key="boards" className="shrink-0">
          <section aria-label="Boards" className="shrink-0 px-1.5 py-2">
            <h2 className="text-text-muted px-3 pb-1 text-xs font-medium">Boards</h2>
            <div className="relative isolate">
              <Glide
                rows="[data-sidebar-row]"
                selected="[data-active]"
                className="bg-foreground/[0.04] rounded-lg"
              />
              {data.map((board) => (
                <SidebarRow
                  key={board.id}
                  isActive={board.id === selected}
                  variant="action"
                  asChild
                >
                  <button
                    type="button"
                    aria-current={board.id === selected ? "page" : undefined}
                    onClick={() => {
                      openBoard(board.id);
                      if (isMobile) setOpenMobile(false);
                    }}
                  >
                    <SidebarRowMain>
                      <Hash size={14} className="text-text-muted shrink-0" />
                      <span className="truncate text-sm">{channelName(board.name)}</span>
                    </SidebarRowMain>
                    {board.last_seq > (seen[scope + board.id] ?? 0) && (
                      <span
                        className="bg-accent-gold size-1.5 shrink-0 rounded-full"
                        aria-label="Unread posts"
                      />
                    )}
                  </button>
                </SidebarRow>
              ))}
            </div>
          </section>
        </Collapse>
      )}
    </AnimatePresence>
  );
}
