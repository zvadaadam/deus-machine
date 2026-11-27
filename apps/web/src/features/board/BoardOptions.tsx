import { useMutationState, useMutation } from "@tanstack/react-query";
import Markdown from "react-markdown";
import type { BoardPost } from "@shared/boards";
import { api } from "@shared/api";
import { uuidv7 } from "@shared/lib/uuid";
import { getErrorMessage } from "@shared/lib/errors";
import { useRuntimeClient } from "@/platform/ws/useRuntimeClient";
import type { boardOptions } from "./options";

export function BoardOptions({
  boardId,
  post,
  choices,
}: {
  boardId: string;
  post: BoardPost;
  choices: NonNullable<ReturnType<typeof boardOptions>>;
}) {
  const runtime = useRuntimeClient();
  const mutationKey = [api.postBoardMessage.name, post.id];
  // The channel and open thread can show the same question until its live update arrives.
  const submitted = useMutationState({
    filters: { mutationKey },
    select: ({ state }) => state.status === "pending" || state.status === "success",
  }).some(Boolean);
  const answer = useMutation({
    mutationKey,
    mutationFn: (body: string) =>
      runtime.call(api.postBoardMessage, {
        boardId,
        thread: post.thread_seq ?? post.seq,
        postId: uuidv7(),
        body,
      }),
  });
  return (
    <div className="my-2 grid w-full max-w-lg gap-1.5">
      {choices.options.map(({ number, text }, index) => (
        <button
          key={index}
          type="button"
          disabled={submitted}
          onClick={() => answer.mutate(`${number}. ${text}`)}
          className="border-border-default bg-bg-elevated text-text-secondary hover:bg-control-hover hover:text-foreground focus-visible:ring-ring flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-left text-sm transition-colors focus-visible:ring-2 disabled:opacity-60 pointer-coarse:min-h-11"
        >
          <span className="bg-bg-raised grid min-h-5 min-w-5 shrink-0 place-items-center rounded-md px-1 text-xs font-medium tabular-nums">
            {number}
          </span>
          <span className="min-w-0 wrap-anywhere">
            <Markdown allowedElements={["code", "em", "strong"]} unwrapDisallowed skipHtml>
              {choices.references + text}
            </Markdown>
          </span>
        </button>
      ))}
      {answer.error && (
        <p role="alert" className="text-accent-red text-sm">
          {getErrorMessage(answer.error)}
        </p>
      )}
    </div>
  );
}
