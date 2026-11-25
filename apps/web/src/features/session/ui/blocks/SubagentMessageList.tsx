import { memo, useMemo } from "react";
import type { Message } from "../../types";
import { assistantTurnContent } from "../../lib/assistantTurnContent";
import { PartsRenderer } from "./PartsRenderer";

export const SubagentMessageList = memo(function SubagentMessageList({
  messages,
}: {
  messages: Message[];
}) {
  const parts = useMemo(
    () =>
      messages.flatMap((message) => (message.role === "assistant" ? (message.parts ?? []) : [])),
    [messages]
  );
  const rows = useMemo(() => assistantTurnContent(parts), [parts]);
  if (!parts.length) return null;
  return (
    <div className="border-border/30 flex flex-col gap-0.5 border-l pl-3">
      <PartsRenderer parts={parts} rows={rows} />
    </div>
  );
});
