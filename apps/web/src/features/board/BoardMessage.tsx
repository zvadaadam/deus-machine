import { Fragment, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@shared/api";
import type { Board, BoardRow } from "@shared/boards";
import { getErrorMessage } from "@shared/lib/errors";
import { ChatMarkdown } from "@/components/markdown";
import { chatTabLabel } from "@/features/session/ui/tabs/types";
import { openChat } from "@/features/session/lib/openChat";
import type { SidebarProfile } from "@/features/sidebar/model/types";
import { profileName } from "@/features/sidebar/ui/ProfileAvatar";
import { linkToWorkspace } from "@/features/workspace/lib/workspaceAddress";
import { getRuntimeClient, runtimeForQueryClient } from "@/platform/ws";
import { cn } from "@/shared/lib/utils";
import { openBoard } from "./address";
import { BoardAvatar } from "./BoardAvatar";
import { boardMentions } from "./mentions";

function Receipt({ board, post }: { board: Board; post: BoardRow }) {
  const runtime = runtimeForQueryClient(useQueryClient()) ?? getRuntimeClient();
  const retry = useMutation({
    mutationFn: () => runtime.call(api.retryBoardMessage, { boardId: board.id, seq: post.seq }),
  });
  if (!post.delivery) return null;
  if (post.delivery === "not_delivered")
    return (
      <div role="status" className="text-text-muted mt-1.5 text-xs">
        {post.delivery_refusal
          ? "Not delivered: " + post.delivery_refusal
          : "Not delivered: the coordinator chat didn't get this."}
        {!board.read_only && (
          <button
            type="button"
            className="text-foreground ml-2 underline underline-offset-2"
            disabled={retry.isPending}
            onClick={() => retry.mutate()}
          >
            Send again
          </button>
        )}
        {retry.error && <span role="alert"> {getErrorMessage(retry.error)}</span>}
      </div>
    );
  const chatTitle = chatTabLabel({
    title: post.delivery_title,
    sequence: post.delivery_chat ?? undefined,
    agentHarness: post.delivery_harness ?? "",
  });
  const title = `${post.delivery === "waiting" ? "Queued for" : "Sent to"} Coordinator · ${chatTitle}`;
  const chat = post.delivery_session_id;
  return (
    <div role="status" className="text-text-muted mt-1.5 flex items-center gap-1.5 text-xs">
      <BoardAvatar kind="bot" board={board} className="size-3.5" />
      {chat && !post.delivery_hidden && !board.read_only ? (
        <a
          href={linkToWorkspace({ workspaceId: board.workspace_id, sessionId: chat })}
          className="hover:text-foreground hover:underline"
          onClick={(event) => {
            if (event.button || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
              return;
            event.preventDefault();
            openChat(board.workspace_id, chat);
          }}
        >
          {title}
        </a>
      ) : (
        title
      )}
    </div>
  );
}

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

type MessageProps = { board: Board; profile: SidebarProfile; post: BoardRow };

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
  const time = localDate(post.created_at);
  return (
    <article
      data-message={post.id}
      data-seq={post.seq}
      className={cn(
        "group grid grid-cols-[32px_minmax(0,1fr)] items-start gap-x-3 px-3 py-2 md:px-4",
        entering && "chat-item-enter",
        selected && "bg-bg-selection"
      )}
    >
      <BoardAvatar kind={post.author_kind} board={board} profile={profile} />
      <div className="min-w-0">
        <div className="mb-1 flex min-h-5 flex-wrap items-center gap-x-2">
          <strong className="text-foreground text-base font-semibold wrap-anywhere">
            {coordinator ? "Coordinator" : person}
          </strong>
          <time
            className="text-text-muted text-xs tabular-nums"
            dateTime={time.toISOString()}
            title={time.toLocaleString()}
          >
            {clock.format(time)}
          </time>
        </div>
        <ChatMarkdown
          transformText={coordinator ? transform : undefined}
          className="text-foreground wrap-anywhere"
        >
          {post.body}
        </ChatMarkdown>
        {!coordinator && <Receipt board={board} post={post} />}
        {children}
      </div>
    </article>
  );
}
