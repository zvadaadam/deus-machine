import { Fragment, useMemo, useState, type ReactNode } from "react";
import { postFileWorkspace, type BoardDetail, type BoardRow } from "@shared/boards";
import { BoardMarkdown } from "./BoardMarkdown";
import type { SidebarProfile } from "@/features/sidebar/model/types";
import { profileName } from "@/features/sidebar/ui/ProfileAvatar";
import { cn } from "@/shared/lib/utils";
import { openBoard } from "./address";
import { BoardAvatar } from "./BoardAvatar";
import { BoardReceipt } from "./BoardReceipt";
import { WorkspaceChip } from "./WorkspaceChip";
import { boardMentions } from "./mentions";

const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
function localDate(stamp: string) {
  return new Date(stamp.includes("T") ? stamp : stamp.replace(" ", "T") + "Z");
}

function dayLabel(date: Date) {
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return "Today";
  today.setDate(today.getDate() - 1);
  return date.toDateString() === today.toDateString()
    ? "Yesterday"
    : date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

export const replyCount = (count: number) => count + (count === 1 ? " reply" : " replies");

type MessageProps = { board: BoardDetail; profile: SidebarProfile; post: BoardRow };

export function BoardRows({
  board,
  profile,
  posts,
  channel,
  selected,
  previousDate,
}: Omit<MessageProps, "post"> & {
  posts: BoardRow[];
  channel?: boolean;
  selected?: number;
  previousDate?: string;
}) {
  const [initialSeq] = useState(() => posts.at(-1)?.seq ?? 0);
  let day = previousDate && localDate(previousDate).toDateString();
  return posts.map((post) => {
    const date = localDate(post.created_at);
    const showDay = day !== date.toDateString();
    day = date.toDateString();
    return (
      <Fragment key={post.id}>
        {showDay && (
          <p className="text-text-muted px-4 pt-4 pb-1 text-xs font-medium">{dayLabel(date)}</p>
        )}
        <BoardMessage
          board={board}
          profile={profile}
          post={post}
          selected={post.seq === selected}
          entering={post.seq > initialSeq}
        >
          {channel && (
            <button
              type="button"
              aria-expanded={post.seq === selected}
              onClick={() => openBoard(board.id, post.seq)}
              className={cn(
                "text-accent-blue mt-1.5 rounded-sm py-0.5 text-xs font-medium hover:underline pointer-coarse:min-h-9",
                !post.reply_count &&
                  "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
              )}
            >
              {post.reply_count ? replyCount(post.reply_count) : "Reply in thread"}
            </button>
          )}
        </BoardMessage>
      </Fragment>
    );
  });
}

function BoardMessage({
  board,
  profile,
  post,
  selected,
  entering,
  children,
}: MessageProps & {
  entering: boolean;
  selected?: boolean;
  children?: ReactNode;
}) {
  const coordinator = post.author_kind === "bot";
  const person = profileName(profile);
  const transform = useMemo(() => boardMentions(person), [person]);
  const subject = post.about_workspace_id && board.workspaces[post.about_workspace_id];
  const time = localDate(post.created_at);
  return (
    <article
      data-message={post.id}
      data-seq={post.seq}
      className={cn(
        "group grid grid-cols-[32px_minmax(0,1fr)] items-start gap-x-3 px-3 py-3 md:px-4",
        entering && "chat-item-enter",
        selected && "bg-bg-selection"
      )}
    >
      <BoardAvatar kind={post.author_kind} board={board} profile={profile} />
      <div className="min-w-0">
        <div className="mb-1.5 flex min-h-5 flex-wrap items-center gap-x-2">
          <strong className="text-foreground text-base font-semibold wrap-anywhere">
            {coordinator ? "Coordinator" : person}
          </strong>
          {coordinator && subject && (
            <WorkspaceChip
              id={post.about_workspace_id}
              name={subject.name}
              archived={subject.archived}
            />
          )}
          <time
            className="text-text-muted text-xs tabular-nums"
            dateTime={time.toISOString()}
            title={time.toLocaleString()}
          >
            {clock.format(time)}
          </time>
        </div>
        <BoardMarkdown
          workspaceId={postFileWorkspace(post, board)}
          transformText={coordinator ? transform : undefined}
          className="text-foreground wrap-anywhere"
        >
          {post.body}
        </BoardMarkdown>
        {!coordinator && <BoardReceipt board={board} post={post} />}
        {children}
      </div>
    </article>
  );
}
