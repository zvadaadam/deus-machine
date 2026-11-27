import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { JumpToLatest } from "@/components/ui/jump-to-latest";
import { useAutoScroll } from "@/features/session/hooks/useAutoScroll";
import type { BoardPost } from "@shared/boards";

export function BoardScroll({
  label,
  posts,
  earlier,
  before,
  page,
  children,
}: {
  label: string;
  posts: readonly BoardPost[];
  earlier?: number;
  before?: number;
  page: (before?: number) => void;
  children: ReactNode;
}) {
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const newest = posts.at(-1);
  const {
    showScrollButton,
    handleScrollToBottomClick,
    transcriptRef,
    stopChase,
    preserveScrollPosition,
  } = useAutoScroll({
    running: false,
    // The sequence still advances when a new post replaces the oldest row of a full page.
    contentCount: newest?.seq ?? 0,
    lastContentId: newest?.id ?? null,
    messagesContainerRef: container,
    userSendCount: 0,
  });
  useLayoutEffect(() => {
    const el = container.current;
    if (el)
      preserveScrollPosition(() => {
        el.scrollTop = before ? 0 : el.scrollHeight;
      });
  }, [before, preserveScrollPosition]);
  return (
    <div className="relative min-h-0 flex-1">
      <div
        id={id}
        role="region"
        aria-label={label}
        ref={container}
        onWheel={stopChase}
        onTouchStart={stopChase}
        onKeyDown={stopChase}
        className="h-full overflow-y-auto overscroll-contain"
      >
        <div ref={transcriptRef} className="pb-3">
          {(earlier || before) && (
            <nav
              aria-label={label + " pages"}
              className="text-text-secondary flex justify-center gap-4 px-4 pt-2 text-xs"
            >
              {earlier && (
                <button
                  type="button"
                  className="py-2 hover:underline"
                  onClick={() => page(earlier)}
                >
                  Load earlier
                </button>
              )}
              {before && (
                <button type="button" className="py-2 hover:underline" onClick={() => page()}>
                  Back to latest
                </button>
              )}
            </nav>
          )}
          {children}
        </div>
      </div>
      <JumpToLatest visible={showScrollButton} onClick={handleScrollToBottomClick} controls={id} />
    </div>
  );
}
