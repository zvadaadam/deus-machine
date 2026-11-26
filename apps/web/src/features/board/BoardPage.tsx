import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, X } from "lucide-react";
import type { BoardDetail } from "@shared/boards";
import { getErrorMessage } from "@shared/lib/errors";
import { SidebarInset } from "@/components/ui/sidebar";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { useUnreadStore } from "@/features/session/store/unreadStore";
import type { SidebarProfile } from "@/features/sidebar/model/types";
import { AnimatePresence, m } from "framer-motion";
import { tempo } from "@/shared/lib/tempo";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/shared/lib/utils";
import { openBoard, type BoardLink } from "./address";
import { BoardHeader } from "./BoardHeader";
import { BoardComposer } from "./BoardComposer";
import { BoardRows, replyCount } from "./BoardMessage";
import { BoardScroll } from "./BoardScroll";
import { useBoardChannel, useBoardThread, useBoardSeenScope } from "./queries";

function LoadingRows({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-6 p-4">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex gap-3" aria-hidden>
          <Skeleton className="size-8" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ThreadPane({
  board,
  profile,
  thread,
  mobile,
}: {
  board: BoardDetail;
  profile: SidebarProfile;
  thread: number;
  mobile: boolean;
}) {
  const [before, page] = useState<number>();
  const latest = useCallback(() => page(undefined), []);
  const { data, error } = useBoardThread({ boardId: board.id, thread, before });
  const CloseIcon = mobile ? ArrowLeft : X;
  return (
    <aside aria-label="Thread" className="bg-bg-surface flex h-full min-w-0 flex-col">
      <header className="border-border-subtle flex h-11 shrink-0 items-center gap-2 border-b px-4">
        <h2 className="text-foreground text-base font-semibold">Thread</h2>
        <button
          type="button"
          aria-label={mobile ? "Back to channel" : "Close thread"}
          className={cn(
            "hover:bg-control-hover grid size-8 place-items-center rounded-md pointer-coarse:size-11",
            mobile ? "order-first -ml-3" : "ml-auto"
          )}
          onClick={() => openBoard(board.id)}
        >
          <CloseIcon size={16} />
        </button>
      </header>
      {data ? (
        <>
          <BoardScroll
            label="Thread messages"
            posts={data.replies}
            before={before}
            page={page}
            earlier={data.hasEarlier ? data.replies[0]?.seq : undefined}
          >
            <BoardRows board={board} profile={profile} posts={[data.root]} />
            <p className="text-text-muted px-4 pt-4 text-xs font-medium">
              {replyCount(data.root.reply_count)}
            </p>
            <BoardRows
              key={before ?? "latest"}
              board={board}
              profile={profile}
              posts={data.replies}
              previousDate={data.root.created_at}
            />
          </BoardScroll>
          <BoardComposer board={board} thread={thread} posts={data.replies} onPosted={latest} />
        </>
      ) : error ? (
        <p role="status" className="text-text-muted p-4 text-sm">
          {getErrorMessage(error)}
        </p>
      ) : (
        <LoadingRows label="Loading thread" />
      )}
    </aside>
  );
}

type BoardPageProps = { address: BoardLink; profile: SidebarProfile };
function Channel({
  address: { boardId, thread },
  profile,
  compact,
}: BoardPageProps & { compact: boolean }) {
  const [before, page] = useState<number>();
  const latest = useCallback(() => page(undefined), []);
  const { data, error } = useBoardChannel({ boardId, before });
  const covered = compact && !!thread;
  const seenKey = useBoardSeenScope() + boardId;
  const lastSeq = data?.board.last_seq;
  useEffect(() => {
    if (lastSeq === undefined || before || covered) return;
    const seen = () => {
      if (!document.hidden) useUnreadStore.getState().seeBoard(seenKey, lastSeq);
    };
    seen();
    document.addEventListener("visibilitychange", seen);
    return () => document.removeEventListener("visibilitychange", seen);
  }, [seenKey, lastSeq, before, covered]);
  useEffect(() => {
    if (!thread) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) openBoard(boardId);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [boardId, thread]);
  if (data === undefined && !error) return <LoadingRows label="Loading board" />;
  if (!data)
    return (
      <p role="status" className="text-text-muted p-6 text-sm">
        {error ? getErrorMessage(error) : "This board was removed with its project."}
      </p>
    );
  const { board, posts } = data;
  const threadPane = thread && (
    <ThreadPane key={thread} board={board} profile={profile} thread={thread} mobile={compact} />
  );
  const channel = (
    <main className={cn("mx-auto flex h-full w-full min-w-0 flex-col", !thread && "max-w-[880px]")}>
      <BoardHeader board={board} />
      <BoardScroll
        label="Channel messages"
        posts={posts}
        before={before}
        page={page}
        earlier={posts[0] && posts[0].seq > 1 ? posts[0].seq : undefined}
      >
        {!posts.length && (
          <p className="text-text-muted px-4 py-3 text-sm">
            No posts yet. The coordinator posts here when it starts or finishes work.
          </p>
        )}
        <BoardRows
          key={before ?? "latest"}
          board={board}
          profile={profile}
          posts={posts}
          channel
          selected={thread}
        />
      </BoardScroll>
      <BoardComposer board={board} posts={posts} onPosted={latest} />
    </main>
  );
  if (compact)
    return (
      <>
        <div className="h-full min-h-0" {...(covered && { inert: "" })} aria-hidden={covered}>
          {channel}
        </div>
        <AnimatePresence initial={false}>
          {threadPane && (
            <m.div
              key="thread"
              className="absolute inset-0 z-10"
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={tempo.slow.layout}
            >
              {threadPane}
            </m.div>
          )}
        </AnimatePresence>
      </>
    );
  return (
    <ResizablePanelGroup direction="horizontal" autoSaveId="board-thread">
      <ResizablePanel id="board-channel" order={1} defaultSize={55} minSize={25}>
        {channel}
      </ResizablePanel>
      {threadPane && <ResizableHandle />}
      {threadPane && (
        <ResizablePanel id="board-thread" order={2} defaultSize={45} minSize={25}>
          {threadPane}
        </ResizablePanel>
      )}
    </ResizablePanelGroup>
  );
}

export function BoardPage(props: BoardPageProps) {
  const container = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState<boolean>();
  useLayoutEffect(() => {
    const element = container.current!;
    const measure = () => setCompact(element.clientWidth < 840);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <SidebarInset className="min-w-0">
      <div
        ref={container}
        className="border-border-subtle bg-bg-surface relative flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-xl border"
      >
        {compact !== undefined && <Channel {...props} compact={compact} />}
      </div>
    </SidebarInset>
  );
}
