import { useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "@shared/api";
import { boardReadOnlyReason, channelName, type Board, type BoardPost } from "@shared/boards";
import { getErrorMessage } from "@shared/lib/errors";
import {
  ComposerInputGroup,
  ComposerSendButton,
  InputGroupTextarea,
  InputGroupAddon,
} from "@/components/ui/input-group";
import { useComposerDraft } from "@/features/session/hooks/useSessionComposer";
import { useRuntimeClient } from "@/platform/ws/useRuntimeClient";

export function BoardComposer({
  board,
  thread,
  posts,
  onPosted,
}: {
  board: Board;
  thread?: number;
  posts: readonly BoardPost[];
  onPosted: () => void;
}) {
  const { draft, setDraft, beginSubmission, finishSubmission, pendingSubmission } =
    useComposerDraft(thread ? `board:${board.id}:${thread}` : `board:${board.id}`);
  const runtime = useRuntimeClient();
  const send = useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) =>
      runtime.call(api.postBoardMessage, { boardId: board.id, thread, body, postId: id }),
    onSuccess: (_, { id }) => {
      if (finishSubmission(id)) onPosted();
    },
  });
  // A live read may confirm a send even when its acknowledgement was lost.
  useEffect(() => {
    if (
      pendingSubmission &&
      posts.some((post) => post.id === pendingSubmission.id) &&
      finishSubmission(pendingSubmission.id)
    )
      onPosted();
  }, [pendingSubmission, posts, finishSubmission, onPosted]);
  if (board.read_only)
    return (
      <p className="text-text-muted px-4 py-3 text-sm">{boardReadOnlyReason[board.read_only]}</p>
    );
  const label = thread ? "Reply…" : "Message #" + channelName(board.name);
  const canSend = !!draft.trim() && !send.isPending;
  const submit = () => {
    if (canSend) send.mutate({ id: beginSubmission(draft), body: draft });
  };
  return (
    <form
      aria-label={thread ? "Reply to thread" : "Channel message"}
      className="shrink-0 px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <ComposerInputGroup>
        <InputGroupTextarea
          aria-label={label}
          placeholder={label}
          rows={2}
          maxLength={8000}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          className="placeholder:text-placeholder max-h-48 min-h-12 overflow-y-auto px-4 py-3 pointer-coarse:text-[16px]"
        />
        <InputGroupAddon align="block-end" className="justify-end px-2 pt-0 pb-2">
          <ComposerSendButton
            hasContent={!!draft.trim()}
            type="submit"
            aria-label={thread ? "Send reply" : "Send message"}
            disabled={!canSend}
          />
        </InputGroupAddon>
      </ComposerInputGroup>
      {send.error && pendingSubmission?.id === send.variables?.id && (
        <p role="alert" className="text-accent-red mt-1 text-sm">
          {getErrorMessage(send.error)}
        </p>
      )}
    </form>
  );
}
