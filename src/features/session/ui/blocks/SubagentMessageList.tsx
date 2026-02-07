/**
 * Subagent Message List
 *
 * Compact renderer for subagent child messages.
 * Renders content blocks (tool calls, text, thinking) from subagent messages
 * using the existing BlockRenderer, with tighter spacing and indentation.
 */

import { memo, useMemo } from "react";
import type { Message } from "@/shared/types";
import type { ContentBlock } from "@/features/session/types";
import { BlockRenderer } from "./BlockRenderer";
import { useSession } from "../../context";

interface SubagentMessageListProps {
  messages: Message[];
}

export const SubagentMessageList = memo(function SubagentMessageList({
  messages,
}: SubagentMessageListProps) {
  const { parseContent } = useSession();

  // Parse all messages into content blocks, filtering out tool_result-only and empty messages
  const renderableBlocks = useMemo(() => {
    const blocks: Array<{ block: ContentBlock | string; key: string }> = [];

    messages.forEach((message) => {
      const contentBlocks = parseContent(message.content);
      if (!Array.isArray(contentBlocks)) return;

      // Skip messages that are only tool_results (they link to tool_use via toolResultMap)
      const onlyToolResults =
        contentBlocks.length > 0 &&
        contentBlocks.every(
          (b: ContentBlock | string) => typeof b === "object" && b?.type === "tool_result"
        );
      if (onlyToolResults) return;

      contentBlocks.forEach((block: ContentBlock | string, index: number) => {
        // Skip standalone tool_result blocks (they render inline with tool_use)
        if (typeof block === "object" && block?.type === "tool_result") return;

        const key =
          typeof block === "object" && block?.type === "tool_use"
            ? block.id
            : `${message.id}:${index}`;

        blocks.push({ block, key });
      });
    });

    return blocks;
  }, [messages, parseContent]);

  if (renderableBlocks.length === 0) return null;

  return (
    <div className="border-border/30 flex flex-col gap-0.5 border-l pl-3">
      {renderableBlocks.map(({ block, key }, index) => (
        <BlockRenderer
          key={key}
          block={block}
          index={index}
          role="assistant"
          isLastTextBlock={false}
        />
      ))}
    </div>
  );
});
