/**
 * Assistant Turn Component
 *
 * Wraps consecutive assistant messages into a collapsible "turn".
 * A turn = all assistant messages between user messages.
 *
 * Two rendering modes:
 *
 * STREAMING (isLatest && isWorking):
 *   All messages render via MessageItem → PartsRenderer.
 *   Tool grouping happens inside PartsRenderer (per-message).
 *
 * COMPLETED (!isWorking or !isLatest):
 *   Messages split into hidden (all but last) + summary (last).
 *   Hidden messages are collapsible behind a TurnStatsHeader.
 *   Summary message is always visible (the final text response).
 *
 * Cancellation:
 *   Detected via message.cancelled_at or message.stop_reason === "cancelled".
 *   The "Response stopped" badge replaces the summary slot.
 */

import { useMemo, useState, memo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Message } from "@/shared/types";
import { MessageItem } from "./MessageItem";
import { TurnFooter } from "./TurnFooter";
import { TurnStatsHeader } from "./TurnStatsHeader";
import { calculateTurnStats } from "./utils";
import { Square } from "lucide-react";

interface AssistantTurnProps {
  messages: Message[];
  isLatest: boolean;
  isWorking: boolean;
  startedAt?: string | null;
}

/**
 * Previous turns never change after they're sealed. Only the latest turn
 * re-renders as new messages stream in.
 */
export const AssistantTurn = memo(function AssistantTurn({
  messages,
  isLatest,
  isWorking,
  startedAt,
}: AssistantTurnProps) {
  const [isManuallyExpanded, setIsManuallyExpanded] = useState<boolean | null>(null);
  const isExpanded = isManuallyExpanded !== null ? isManuallyExpanded : isLatest;

  // Simplified stats — no parseContent needed, just count parts
  const stats = useMemo(() => calculateTurnStats(messages), [messages]);

  const isStreaming = isLatest && isWorking;

  // Detect cancellation via message fields (not content envelope)
  const isCancelled = useMemo(() => {
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg) return false;
    if (lastMsg.cancelled_at) return true;
    if (lastMsg.stop_reason === "cancelled") return true;
    return false;
  }, [messages]);

  // Split messages: all except the last are hidden (collapsible), last is the summary.
  const { summaryMessage, hiddenMessages } = useMemo(() => {
    if (isCancelled) {
      // Keep the last real message visible (partial response) with badge below it
      return {
        summaryMessage: messages[messages.length - 1],
        hiddenMessages: messages.slice(0, -1),
      };
    }
    return {
      summaryMessage: messages[messages.length - 1],
      hiddenMessages: messages.slice(0, -1),
    };
  }, [messages, isCancelled]);

  return (
    <div
      className="assistant-turn flex w-full min-w-0 flex-col"
      style={{ contain: "layout style" }}
    >
      {/* Stats header — visible for multi-message turns (completed only) */}
      {!isStreaming && hiddenMessages.length > 0 && (
        <TurnStatsHeader
          stats={stats}
          isExpanded={isExpanded}
          onClick={() => setIsManuallyExpanded(!isExpanded)}
          hiddenMessageCount={hiddenMessages.length}
        />
      )}

      {isStreaming ? (
        /* ── STREAMING: render all messages sequentially ── */
        <div className="flex min-w-0 flex-col gap-1">
          {messages.map((message) => (
            <MessageItem
              key={message.id}
              message={message}
              isLastInTurn={message.id === messages[messages.length - 1]?.id}
              isStreamingTurn={true}
            />
          ))}
        </div>
      ) : (
        /* ── COMPLETED: hidden/summary split ── */
        <>
          <AnimatePresence initial={false}>
            {isExpanded && hiddenMessages.length > 0 && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2, ease: [0.165, 0.84, 0.44, 1] as const }}
                style={{ overflow: "hidden" }}
                className="flex min-w-0 flex-col gap-1"
              >
                {hiddenMessages.map((message) => (
                  <MessageItem key={message.id} message={message} />
                ))}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Summary: last message + stopped badge if cancelled */}
          {summaryMessage && <MessageItem message={summaryMessage} isLastInTurn={true} />}
          {isCancelled && (
            <div className="border-warning/20 border-l-warning bg-warning/5 mx-2 flex items-center gap-2.5 rounded-lg border border-l-2 px-3 py-2">
              <Square className="text-warning/60 h-3.5 w-3.5 shrink-0 fill-current" />
              <span className="text-warning text-sm font-medium">Response stopped</span>
            </div>
          )}
          <TurnFooter messages={messages} startedAt={startedAt} />
        </>
      )}
    </div>
  );
});
