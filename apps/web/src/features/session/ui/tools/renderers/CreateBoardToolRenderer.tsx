import { Hash } from "lucide-react";
import { channelName } from "@shared/boards";
import { isWorkspaceLinkId } from "@shared/workspace-link";
import { boardAddress, openBoard } from "@/features/board/address";
import type { ToolRendererProps } from "../../chat-types";
import { DefaultToolRenderer } from "./DefaultToolRenderer";
import { extractText } from "./shared";

export function CreateBoardToolRenderer(props: ToolRendererProps) {
  const result = props.toolResult;
  if (result && !result.is_error) {
    try {
      const board = JSON.parse(extractText(result.content));
      if (isWorkspaceLinkId(board?.id) && typeof board.name === "string")
        return (
          <a
            href={boardAddress({ boardId: board.id })}
            className="text-text-secondary hover:text-foreground inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm hover:underline"
            onClick={(event) => {
              if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
                return;
              event.preventDefault();
              openBoard(board.id);
            }}
          >
            <Hash size={14} aria-hidden />
            Open #{channelName(board.name)}
          </a>
        );
    } catch {
      /* Older tool results may contain plain text. */
    }
  }
  return <DefaultToolRenderer {...props} />;
}
