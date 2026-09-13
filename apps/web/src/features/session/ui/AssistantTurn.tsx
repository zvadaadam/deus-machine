import { useMemo, useState, useId, memo } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { Message, SessionTurn } from "@/shared/types";
import { turnStopNotice } from "../lib/chatTimeline";
import { PartBlock } from "./blocks/PartBlock";
import { ChatResourceCards } from "./blocks/ChatResourceCards";
import { assistantTurnContent } from "../lib/assistantTurnContent";
import { extractChatResources } from "../lib/chatResources";
import { useSession } from "../context";
import { TurnFooter } from "./TurnFooter";
import { TurnStatsHeader } from "./TurnStatsHeader";
import { calculateTurnStats } from "./utils";
import { Square, TriangleAlert } from "lucide-react";

interface AssistantTurnProps {
  messages: Message[];
  turn?: SessionTurn;
  isLatest: boolean;
  isWorking: boolean;
  startedAt?: string | null;
}

export const AssistantTurn = memo(function AssistantTurn({
  messages,
  turn,
  isLatest,
  isWorking,
  startedAt,
}: AssistantTurnProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const activityId = useId();
  const reducedMotion = useReducedMotion();
  const { workspacePath } = useSession();
  const projected = useMemo(() => assistantTurnContent(messages), [messages]);
  const stats = useMemo(() => calculateTurnStats(messages), [messages]);
  const isStreaming = isLatest && isWorking && !turn?.stopReason && turn?.endedAt === undefined;
  const resources = useMemo(
    () =>
      extractChatResources({
        parts: projected.parts,
        isComplete: !isStreaming,
        workspacePath,
      }),
    [projected.parts, isStreaming, workspacePath]
  );
  const lastPart = projected.parts.at(-1);
  const streamingTextId = lastPart?.type === "text" ? lastPart.id : undefined;

  const isCancelled = turn?.stopReason === "cancelled";
  const stopNotice = turnStopNotice(turn?.stopReason);

  return (
    <div
      className="assistant-turn flex w-full min-w-0 flex-col"
      style={{ contain: "layout style" }}
    >
      {projected.activity.length > 0 && (
        <>
          <TurnStatsHeader
            stats={stats}
            isExpanded={isExpanded}
            onClick={() => setIsExpanded(!isExpanded)}
            activityId={activityId}
            label={isStreaming ? (projected.currentActivity ?? "Working") : "Activity"}
          />
          <AnimatePresence initial={false}>
            {isExpanded && (
              <motion.div
                key="activity"
                id={activityId}
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: reducedMotion ? 0 : 0.2, ease: [0.165, 0.84, 0.44, 1] }}
                className="border-border-subtle ml-3 flex min-w-0 flex-col gap-1 overflow-hidden border-l pl-2"
              >
                {projected.activity.map((part) => (
                  <PartBlock key={part.id} part={part} isStreaming={isStreaming} />
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
      <div className="flex min-w-0 flex-col gap-1 overflow-x-hidden">
        {projected.content.map((part) => (
          <PartBlock
            key={part.id}
            part={part}
            isStreaming={isStreaming && part.id === streamingTextId}
          />
        ))}
        <ChatResourceCards resources={resources} />
      </div>
      {!isStreaming && (
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
          <TurnFooter messages={messages} turn={turn} startedAt={startedAt} />
        </>
      )}
    </div>
  );
});
