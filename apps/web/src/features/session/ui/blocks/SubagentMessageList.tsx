/**
 * Subagent Message List
 *
 * Compact renderer for subagent child messages.
 * Renders content via PartsRenderer with tighter spacing.
 */

import { memo } from "react";
import type { Part } from "@shared/messages/types";
import { PartsRenderer } from "./PartsRenderer";

interface SubagentMessageListProps {
  messages: Array<{ id: string; role: string; parts?: Part[]; content?: string }>;
}

export const SubagentMessageList = memo(function SubagentMessageList({
  messages,
}: SubagentMessageListProps) {
  const renderableMessages = messages.filter(
    (msg) => msg.role === "assistant" && msg.parts && msg.parts.length > 0
  );

  if (renderableMessages.length === 0) return null;

  return (
    <div className="border-border/30 flex flex-col gap-0.5 border-l pl-3">
      {renderableMessages.map((msg) => (
        <PartsRenderer key={msg.id} parts={msg.parts!} isStreamingTurn={false} />
      ))}
    </div>
  );
});
