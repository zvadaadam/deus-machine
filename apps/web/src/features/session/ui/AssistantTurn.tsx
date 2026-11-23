import { memo, useMemo } from "react";
import type { Message, SessionTurn } from "@/shared/types";
import { turnStopNotice } from "../lib/chatTimeline";
import { PartsRenderer } from "./blocks/PartsRenderer";
import { TurnFooter } from "./TurnFooter";
import { Square, TriangleAlert } from "lucide-react";

interface AssistantTurnProps {
  messages: Message[];
  turn?: SessionTurn;
  footerMessages?: Message[];
  isStreaming: boolean;
  startedAt?: string | null;
}

export const AssistantTurn = memo(function AssistantTurn({
  messages,
  turn,
  footerMessages,
  isStreaming,
  startedAt,
}: AssistantTurnProps) {
  const parts = useMemo(() => messages.flatMap((message) => message.parts ?? []), [messages]);
  const isCancelled = turn?.stopReason === "cancelled";
  const stopNotice = turnStopNotice(turn?.stopReason);

  return (
    <div
      className="assistant-turn flex w-full min-w-0 flex-col"
      style={{ contain: "layout style" }}
    >
      <div className="flex min-w-0 flex-col gap-1 overflow-x-hidden">
        <PartsRenderer parts={parts} isStreamingTurn={isStreaming} />
      </div>
      {footerMessages && (
        <>
          {isCancelled && (
            <div className="border-warning/20 border-l-warning bg-warning/5 mx-2 flex items-center gap-2.5 rounded-lg border border-l-2 px-3 py-2">
              <Square className="text-warning/60 h-3.5 w-3.5 shrink-0 fill-current" />
              <span className="text-warning text-sm font-medium">Response stopped</span>
            </div>
          )}
          {!isCancelled && stopNotice && (
            <div className="border-warning/20 border-l-warning bg-warning/5 mx-2 flex items-center gap-2.5 rounded-lg border border-l-2 px-3 py-2">
              <TriangleAlert className="text-warning/60 h-3.5 w-3.5 shrink-0" />
              <span className="text-warning text-sm font-medium">{stopNotice}</span>
            </div>
          )}
          <TurnFooter messages={footerMessages} turn={turn} startedAt={startedAt} />
        </>
      )}
    </div>
  );
});
